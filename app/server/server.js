var express;
var ipfsAPI;
var fs;
var mkdirp;
var http;
var https;
var bodyParser;
var multer;

var app;
var ipfs;

//tracks when emergency refreshes are allowed to prevent minting in /uploaded from triggering multiple times
var lastBlockRefresh = 0;
var blockCreationTimes = [];
var blocks = [];
var foreignBlocks = [];
var postsToMerge = [];
var blocksToMerge = [];
var ownID = "";

//control what the minimum and maximum block creation time is, in miliseconds
var minimumBlockTime = 10 * 1000; //ten seconds
var maximumBlockTime = 60 * 60 * 1000; //one hour
//set target for number of blocks per hour
var targetBlocksPerHour = 6;
//control to fill blockCreationTimes up with dummy values at startup to increase refresh rate or not
var startQuick = true;

var peerNodesList = [];
var peerSitesList = ["https://ipfschan.herokuapp.com"];

var newestBlock = "";

var cfgLocation = __dirname + "/configuration.json";


function isEmpty(obj)
{
	for(var prop in obj)
	{
		if(obj.hasOwnProperty(prop))
		{
			return false;
		}
	}
	return true;
}

function writeIfNotExist(file, content, callback, callbackParmeterObject)
{
	if (!callback)
	{
		callback = function () {};
	}
	if (!callbackParmeterObject)
	{
		callbackParmeterObject = {};
	}
	
	fs.exists(file, function(exists) {
		if (!exists)
		{
			if (!content)
			{
				content = "";
			}
			
			mkdirp(file.replace(/(\/.*\/).*/, "$1"), function (err) {
				if (err)
				{
					//TODO: handle failure
					callback(callbackParmeterObject);
					
					console.log(err);
				}
				
				fs.writeFile(file, content, function (err) {
					if (err)
					{
						//TODO: handle failure
						callback(callbackParmeterObject);
						
						console.log(err);
					}
					
					callback(callbackParmeterObject);
				});
			});
		}
		else
		{
			callback(callbackParmeterObject);
		}
	});
}

function cleanBlockCreationTimes(callback)
{
	if (!callback)
	{
		callback = function(){return true;};
	}
	
	var currentTime = Date.now();
	
	//remove all dates older than one hour
	while(blockCreationTimes[0] < currentTime - (60 * 60 * 1000))
	{
		blockCreationTimes.splice(0, 1);
	}
	
	return callback();
}

function refreshPeerNode(currentNode)
{
	//TODO: refresh peer nodes and call self
	if (!currentNode)
	{
		currentNode = 0;
	}
	
	return cleanBlockCreationTimes(function(){
		if (currentNode >= peerNodesList.length || currentNode < 0)
		{
			currentNode = 0;
		}
		
		if (peerNodesList.length > 0 && currentNode < peerNodesList.length)
		{
			publishBlockPull(peerNodesList[currentNode]);
		}
		
		//delay devided by 2 to be twice as fast
		var delay = Math.ceil((Math.min(maximumBlockTime, Math.ceil(((60 * 60 * 1000 / targetBlocksPerHour) - minimumBlockTime) * ((blockCreationTimes.length) / targetBlocksPerHour) + minimumBlockTime)) + 1) / 2);
		
		return setTimeout(refreshPeerNode, delay, currentNode + 1);
	});

}

function refreshBlockResponse (response)
{
	var str = '';
	
	//another chunk of data has been recieved, so append it to "str"
	response.on('data', function (chunk) {
		str += chunk;
	});
	
	//the whole response has been recieved, so we just print it out here
	response.on('end', function () {
		console.log("string received from foreign host: " + str);
		
		try
		{
			var responseObject = JSON.parse(str);
			
			if (responseObject.hasOwnProperty("block") && responseObject["block"] && responseObject["block"].length === 46)
			{
				var blockString = responseObject["block"];
				
				//if foreignNewest is really an IPFS hash
				//TODO: better checking
				if (blockString.length === 46)
				{
					//only process if foreign newest is actually new (foreign site is active)
					if (foreignBlocks.indexOf(blockString) === -1)
					{
						foreignBlocks.push(blockString);
						blocksToMerge.push(blockString);
					}
				}
				else
				{
					console.log("invalid IPFS hash received from foreign host");
					//TODO: add a failure to a list for this host and reorganize the list to put sites with the largest number of bad responses at the end
					//TODO: scrape result for new URLs
				}
			}
			
			if (responseObject.hasOwnProperty("id") && responseObject["id"] && responseObject["id"] === 46)
			{
				if (responseObject["id"].length === 46)
				{
					addToPeerNodes(responseObject["id"]);
				}
			}
		}
		catch (e)
		{
			console.log(e);
		}
	});
}

function refreshBlockFrom(site)
{
	var protocol = http;
	
	try
	{
		var siteMatches = site.match(/(((https?:\/\/)?(([\da-z\.-]+)\.?([a-z\.]{2,6})?))(:(\d+))?)([\/\w \.-]*)*\/?/);
	}
	catch (e)
	{
		console.log(e);
	}
	
	if (siteMatches)
	{
		if (siteMatches[3] === "https://" || siteMatches[8] === "443")
		{
			//console.log("using https");
			protocol = https;
		}
	}
	
	if (site)
	{
		console.log(site);
		
		try
		{
			var req = protocol.request(site + "/status", refreshBlockResponse);
			req.on('error', function(err) {
				console.log(err);
			});
			req.end();
		}
		catch (e)
		{
			console.log(e);
		}
	}
	else
	{
		//console.log("respite...");
	}
}

function refreshPeerSite(currentPeerSite)
{
	if (!currentPeerSite)
	{
		currentPeerSite = 0;
	}
	
	return cleanBlockCreationTimes(function(){
		if (currentPeerSite >= peerSitesList.length || currentPeerSite < 0)
		{
			currentPeerSite = 0;
		}
		
		if (peerSitesList.length > 0)
		{
			refreshBlockFrom(peerSitesList[currentPeerSite]);
		}
		
		//delay devided by 2 to be twice as fast
		var delay = Math.ceil((Math.min(maximumBlockTime, Math.ceil(((60 * 60 * 1000 / targetBlocksPerHour) - minimumBlockTime) * ((blockCreationTimes.length) / targetBlocksPerHour) + minimumBlockTime)) + 1) / 2);
		
		return setTimeout(refreshPeerSite, delay, currentPeerSite + 1);
	});
}

function createBlockCallback()
{
	//clean blocksToMerge of blocks created by this server
	//this will prevent blocks downloaded from yourself from being re-added
	for (var i = 0; i < blocksToMerge.length; i++)
	{
		blocksToMerge = blocksToMerge.filter(function(element, position, array) {
			return (blocks.indexOf(blocksToMerge[i]) === -1 && foreignBlocks.indexOf(blocksToMerge[i]) === -1);
		});
	}
	
	//only run if there is something to commit
	if (blocksToMerge.length > 0 || postsToMerge.length > 0)
	{
		var newBlockJSON = {};
		var oldBlock = newestBlock.toString();
		
		
		//if there are no new blocks, don't include an ["o"] entry (this is mostly for startup when there is no newest block)
		//TODO: check if this block chain gets to new posts before getting back to all previously included blocks
		if (blocksToMerge.length > 0 || oldBlock)
		{
			//save 128 or less blocks staged to be merged in the newBlockJSON object
			newBlockJSON["o"] = blocksToMerge.splice(0, 128);
			
			if (oldBlock)
			{
				newBlockJSON["o"].push(oldBlock);
			}
			
			//remove duplicates
			newBlockJSON["o"] = filterDuplicates(newBlockJSON["o"]);
			
			if (newBlockJSON["o"].length <= 0)
			{
				delete newBlockJSON["o"];
			}
		}
		
		if (postsToMerge.length > 0)
		{
			//save 128 or less blocks staged to be merged in the newBlockJSON object
			newBlockJSON["n"] = postsToMerge.splice(0, 128);
			
			//remove duplicates
			newBlockJSON["n"] = filterDuplicates(newBlockJSON["n"]);
			
			if (newBlockJSON["n"].length <= 0)
			{
				delete newBlockJSON["n"];
			}
		}
		
		//only mint new if there are new posts or a merged chain
		if ((newBlockJSON.hasOwnProperty("n") && newBlockJSON["n"].length > 0) || (newBlockJSON.hasOwnProperty("o") && newBlockJSON["o"].length > 1))
		{
			var newBlock = JSON.stringify(newBlockJSON).toString();
			
			
			console.log(newBlock);
			
			
			ipfs.add(new Buffer(newBlock.toString()), function(err, res) {
				if(err || !res)
				{
					return console.error(err);
				}
				
				var blockResponse = res;
				
				
				blockResponse.forEach(function(element, elementNumber) {
					if (element.hasOwnProperty("Hash"))
					{
						//store new block hash in core directory
						newestBlock = element["Hash"].toString();
						
						blocks.push(newestBlock);
						
						//push to IPFS node
						publishBlockPush();
						
						//write to file to restore on restart
						writeIfNotExist("/tmp/IPFSchan/block/newest/newest.txt", "", function(){
							fs.writeFile("/tmp/IPFSchan/block/newest/newest.txt", newestBlock, function (err) {
								if (err)
								{
									console.log(err);
								}
							});
						});
						
						var currentTime = Date.now();
						
						blockCreationTimes.push(currentTime);
					}
				});
			});
		}
	}
}

function createBlock()
{
	//clean blockCreationTimes
	return cleanBlockCreationTimes(function(){
		createBlockCallback();
		
		//create new block slower if there are many blocks recently, faster if there are few
		//all in milliseconds, the average block time minus the minimum, times the target number of blocks devided by the actual number of blocks, plus the minimum block time, plus one
		//average block time is calculated by taking one hour in miliseconds and deviding it by the target blocks per hour
		//minimum time is subtracted from average time so that if the number of blocks is equal to the target, the final sum is equal to averageBlockTime
		//blockCreationTimes.length / targetBlocksPerHour is equal to one if the target is met, approaches zero as the number of blocks dwindles, and approaches infinity as the number of blocks increase
		//always add one at the very end to prevent a delay of zero
		var delay = Math.min(maximumBlockTime, Math.ceil(((60 * 60 * 1000 / targetBlocksPerHour) - minimumBlockTime) * ((blockCreationTimes.length) / targetBlocksPerHour) + minimumBlockTime)) + 1;
		
		
		return setTimeout(createBlock, delay);
	});
}

function shouldItBeFile(data, htmlResponse, htmlRequest)
{
	var htmlUrlInfo = htmlRequest.originalUrl.toString().match(/(\/ipfs\/(\w{46}))([\.](\w*))?/);
	
	//no file extensions - just serve it
	if (!htmlUrlInfo || !htmlUrlInfo[3])
	{
		htmlResponse.end(data.toString());
	}
	else
	//has a dot, but nothing else
	if (htmlUrlInfo[3] !== "" && htmlUrlInfo[4] === "")
	{
		htmlResponse.writeHead(302, {'Location': 'http://' + htmlRequest.get('host') + htmlUrlInfo[1]});
		htmlResponse.end();
	}
	else
	{
		var testing = false;
		var isExtremelyBlocking = true;
		
		if (testing || !isExtremelyBlocking)
		{
			var dataInfo = data.match(/data:(.+\/(.+));base64,(.*)/);
			
			if (!dataInfo)
			{
				htmlResponse.end(data);
			}
			else
			{
				if (htmlUrlInfo[4] === dataInfo[2])
				{
					//create buffer with encoded file
					var buffer = new Buffer(dataInfo[3], 'base64');
					
					//this only creates a form of stream, not a full file download
					htmlResponse.writeHead(200, {'Content-Length': buffer.length, 'Content-Type': dataInfo[1]});
					htmlResponse.end(buffer);
				}
				else
				{
					htmlResponse.writeHead(302, {'Location': 'http://' + htmlRequest.get('host') + htmlUrlInfo[1] + "." + dataInfo[2]});
					htmlResponse.end();
				}
			}
		}
		else
		{
			htmlResponse.writeHead(302, {'Location': 'http://' + htmlRequest.get('host') + htmlUrlInfo[1]});
			htmlResponse.end();
		}
	}
}

function maybeAddAsNewest (data)
{
	if (data.toString().length === 46)
	{
		if (!newestBlock)
		{
			newestBlock = data.toString();
		}
		else
		{
			blocksToMerge.push(data.toString());
		}
	}
	
	console.log("newestBlock: " + newestBlock);
	console.log("JSON.stringify(blocksToMerge): " + JSON.stringify(blocksToMerge));
}

function filterDuplicates(arr)
{
	return arr.filter(function(element, position, array){return array.indexOf(element) === position;});
}

function filterBlanks(arr)
{
	return arr.filter(function(element, position, array){return !(element === undefined || element === null || element.length === 0);});
}

function doubleFilter(arr)
{
	return filterBlanks(filterDuplicates(arr));
}

function addToPeerNodes(arr)
{
	peerNodesList = doubleFilter(peerNodesList.concat(arr));
	
	//remove ownID
	if (peerNodesList.indexOf(ownID) !== -1)
	{
		peerNodesList.splice(peerNodesList.indexOf(ownID), 1);
	}
	
	return peerNodesList;
}

function addToPeerSites(arr)
{
	peerSitesList = doubleFilter(peerSitesList.concat(arr));
	
	return peerSitesList;
}

function findOwnID()
{
	return ipfs.id(function(err, res){
		if (err)
		{
			return console.log(err);
		}
		
		console.log("current node ID: " + res["ID"]);
		
		ownID = res["ID"];
		
		//pull own published information
		publishBlockPull(ownID);
		
		return ownID;
	});
}

function publishBlockPull(target, callback)
{
	if (target === undefined || target === null || target.length === 0)
	{
		target = ownID;
	}
	
	var addResultToLists = true;
	var publishedObject = {};
	
	if (!callback)
	{
		callback = function(publishedObject){
			console.log("Successfully added block and peers to lists");
			
			try
			{
				console.log("publishedObject: ");
				console.log(JSON.stringify(publishedObject));
			}
			catch(e)
			{
				console.log("Something went wrong when trying to display publishedObject")
				console.log(e);
			}
			
			console.log("blocksToMerge: ");
			console.log(blocksToMerge);
		};
		
		addResultToLists = true;
	}
	
	
	var finishPublish = function (str, callback){
		try
		{
			publishedObject = JSON.parse(str);
			
			if (addResultToLists)
			{
				maybeAddAsNewest(publishedObject["IPFSchan"]["newestBlock"]);
				foreignBlocks.push(publishedObject["IPFSchan"]["newestBlock"]);
				addToPeerNodes(publishedObject["IPFSchan"]["peerNodes"]);
				addToPeerSites(publishedObject["IPFSchan"]["peerSites"]);
			}
		}
		catch (e)
		{
			console.log(e);
		}
		
		callback(publishedObject);
	};
	
	ipfs.name.resolve(target, function(err, res){
		if (err)
		{
			callback(publishedObject);
			return console.log(err);
		}
		
		console.log(res);
		
		if (res["Path"])
		{
			ipfs.cat(res["Path"], function (err, res){
				if(err || !res)
				{
					callback(publishedObject);
					return console.error(err);
				}
				
				if(res.readable) {
					// Returned as a stream
					// Returned as a stream
					var string = '';
					res.on('data', function(chunk) {
						string += chunk;
					});
					
					res.on('end', function() {
						finishPublish(string, callback);
					});
				}
				else
				{
					// Returned as a string
					finishPublish(res, callback);
				}
			});
		}
	});
}

function publishBlockPush()
{
	//pull current object to preserve unrelated information
	publishBlockPull(ownID, function(publishedObject){
		if (!publishedObject)
		{
			publishedObject = {};
		}
		
		var publishObject = publishedObject;
		
		publishObject["IPFSchan"] = {};
		
		publishObject["IPFSchan"]["newestBlock"] = newestBlock;
		//add ownID in order to broadcast our ID to other nodes
		publishObject["IPFSchan"]["peerNodes"] = doubleFilter(peerNodesList.concat(ownID));
		publishObject["IPFSchan"]["peerSites"] = doubleFilter(peerSitesList);
		
		ipfs.add(new Buffer(JSON.stringify(publishObject).toString()), function(err, res) {
			if(err || !res)
			{
				return console.error(err);
			}
			
			
			res.forEach(function(text, textNumber) {
				if (text.hasOwnProperty("Hash"))
				{
					ipfs.name.publish(text["Hash"], function(err, res){
						if (err)
						{
							return console.log(err);
						}
						
						console.log("published object: " + JSON.stringify(res));
					});
				}
			});
		});
	});
}

function killServer(exitCode)
{
	if (exitCode == null)
	{
		exitCode = 1;
	}
	
	process.exit(exitCode);
}

function quit(exitCode)
{
	if (exitCode == null)
	{
		exitCode = 1;
	}
	
	console.log("Server closed. Exiting process");
	killServer(0);
}

function delayedKill(exitCode)
{
	if (exitCode == null)
	{
		exitCode = 4;
	}
	
	console.log("The process took too long to exit");
	console.log("Forcing exit");
	killServer(exitCode);
}

function delayKill(exitCode)
{
	if (exitCode == null)
	{
		exitCode = 3;
	}
	
	setTimeout(delayedKill, 10 * 1000, exitCode);
}

function postIDToServers()
{
	var postObject = {};
	postObject["IDs"] = [ownID];
	//TODO: add block reference
	//TODO: add site entry if we have it

	var postText = "postText=" + JSON.stringify(postObject);
	var postOptions = {
		path: '/uploaded',
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Content-Length': Buffer.byteLength(postText)
		}
	};

	for (var i = 0; i < peerSitesList.length; i++)
	{
		try
		{
			postOptions["host"] = peerSitesList[i].replace(/http(s)?\:/, "").replace(/\/\//, "");

			var postRequest = http.request(postOptions);

			postRequest.write(postText);
			postRequest.end();
		}
		catch (e)
		{
			console.log("An error occured while trying to share our ID to public servers");
			console.log(e);
		}
	}
}

function main()
{
	var cfgContents = "";
	var cfgObject = {};

	express = require('express');
	ipfsAPI = require('ipfs-api');
	fs = require('fs');
	mkdirp = require("mkdir-p");
	http = require('http');
	https = require('https');
	bodyParser = require('body-parser');
	multer = require('multer');

	

	fs.readFile(cfgLocation, function (err, data){
		if (err)
		{
			console.log("Error reading configuration file");
			return console.log(err);
		}

		//try decode object
		try
		{
			cfgObject = JSON.parse(data);
		}
		catch (e)
		{
			console.log("Error parsing configuration file");
			return console.log(e);
		}

		return cfgObject;
	});

	//fill cfgObject with defaults
	//IPFS options
	if (!(cfgObject.hasOwnProperty("ipfsAPI") && cfgObject["ipfsAPI"]))
	{
		cfgObject["ipfsAPI"] = {};
	}

	if (!(cfgObject["ipfsAPI"].hasOwnProperty("domain") && cfgObject["ipfsAPI"]["domain"]))
	{
		cfgObject["ipfsAPI"]["domain"] = "localhost";
	}

	if (!(cfgObject["ipfsAPI"].hasOwnProperty("port") && cfgObject["ipfsAPI"]["port"]))
	{
		cfgObject["ipfsAPI"]["port"] = "5001";
	}

	if (!(cfgObject["ipfsAPI"].hasOwnProperty("options") && cfgObject["ipfsAPI"]["options"]))
	{
		cfgObject["ipfsAPI"]["options"] = {protocol: 'http'};
	}

	//other options
	if (cfgObject.hasOwnProperty("minimumBlockTime") && cfgObject["minimumBlockTime"])
	{
		minimumBlockTime = cfgObject["minimumBlockTime"];
	}
	else
	{
		cfgObject["minimumBlockTime"] = minimumBlockTime;
	}

	if (cfgObject.hasOwnProperty("maximumBlockTime") && cfgObject["maximumBlockTime"])
	{
		maximumBlockTime = cfgObject["maximumBlockTime"];
	}
	else
	{
		 cfgObject["maximumBlockTime"] = maximumBlockTime;
	}

	if (cfgObject.hasOwnProperty("targetBlocksPerHour") && cfgObject["targetBlocksPerHour"])
	{
		targetBlocksPerHour = cfgObject["targetBlocksPerHour"];
	}
	else
	{
		 cfgObject["targetBlocksPerHour"] = targetBlocksPerHour;
	}

	if (cfgObject.hasOwnProperty("startQuick") && cfgObject["startQuick"])
	{
		startQuick = cfgObject["startQuick"];
	}
	else
	{
		 cfgObject["startQuick"] = startQuick;
	}

	if (cfgObject.hasOwnProperty("peerNodesList") && cfgObject["peerNodesList"])
	{
		peerNodesList = cfgObject["peerNodesList"];
	}
	else
	{
		 cfgObject["peerNodesList"] = peerNodesList;
	}

	if (cfgObject.hasOwnProperty("peerSitesList") && cfgObject["peerSitesList"])
	{
		peerSitesList = cfgObject["peerSitesList"];
	}
	else
	{
		 cfgObject["peerSitesList"] = peerSitesList;
	}

	//TODO: have newest.txt location be configurable?
	fs.readFile("/tmp/IPFSchan/block/newest/newest.txt", function (err, data) {
		if (err)
		{
			console.log("Error reading file that stores initial block");
			return console.log(err);
		}

		maybeAddAsNewest(data.toString());
		return console.log("newestBlock: " + newestBlock);
	});

	if (cfgObject.hasOwnProperty("newestBlock") && cfgObject["newestBlock"])
	{
		maybeAddAsNewest(cfgObject["newestBlock"]);
	}

	cfgObject["newestBlock"] = newestBlock;
	
	//write configuration object
	fs.writeFile(cfgLocation, JSON.stringify(cfgObject), function (err) {
		if (err)
		{
			console.log("Error writing configuration file");
			return console.log(err);
		}
		else
		{
			//TODO: delete newest.txt?
			console.log("wrote configuration:");
			return console.log(JSON.stringify(cfgObject));
		}
	});

	//fill blockCreationTimes with dummy values to create baseline
	var currentTime = Date.now();
	//only if global variable is set
	if (startQuick)
	{
		for (var i = 0; i < targetBlocksPerHour; i++)
		{
			blockCreationTimes.push(currentTime + i * 60 * 1000);
		}
	}

	

	//set values from environment vars
	//for if the ipfs node is behind tor
	if (process.env.IPFSserviceID && process.env.IPFStorMirrorDomain)
	{
		cfgObject["ipfsAPI"]["domain"] = (process.env.IPFSserviceID + "." + process.env.IPFSdomain);
	}

	//for if the ipfs node is at an IP
	if (process.env.IPFSip)
	{
		cfgObject["ipfsAPI"]["domain"] = process.env.IPFSip;
	}

	//if there is a hostname for the IPFS node
	if (process.env.IPFShostname)
	{
		cfgObject["ipfsAPI"]["domain"] = process.env.IPFShostname;
	}

	if (process.env.IPFSport)
	{
		cfgObject["ipfsAPI"]["port"] = process.env.IPFSport;
	}

	if (process.env.IPFSoptions)
	{
		cfgObject["ipfsAPI"]["options"] = JSON.parse(process.env.IPFSoptions);
	}


	console.log("final configuration object: " + JSON.stringify(cfgObject));


	app = express();
	ipfs = ipfsAPI(cfgObject["ipfsAPI"]["domain"], cfgObject["ipfsAPI"]["port"], cfgObject["ipfsAPI"]["options"]);

	findOwnID();
	
	
	//add at least one post (only the empty hash) so that /status always has content
	if (!newestBlock)
	{
		postsToMerge.push("QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
	}
	
	lastBlockRefresh = Date.now() + 10 * 1000
	setTimeout(createBlockCallback, 10 * 1000);
	
	
	//start refreshing from peer nodes
	refreshPeerNode();
	//start auto-refresh from peer sites
	refreshPeerSite();
	//start creating blocks
	createBlock();
	
	
	
	app.set('port', (process.env.PORT || 12462));
	
	app.use(bodyParser.json());
	app.use(bodyParser.urlencoded({ extended: true }));
	
	
	var upload = multer();
	
	app.post('/uploaded', upload.array(), function(req, res, next) {
		console.log(req.body);
		console.log(JSON.stringify(req.body.postText));
		
		var htmlRequest = req;
		var htmlResponse = res;
		
		var responseObject = {};
		
		
		if (htmlRequest.headers.origin)
		{
			if (!(htmlRequest.headers.origin === ""))
			{
				//TODO: check if origin is spamming, in which case don't add this header or deny the request
				htmlResponse.setHeader('Access-Control-Allow-Origin', htmlRequest.headers.origin);
			}
		}
		
		
		//compile postText and add to IPFS
		var postText = "";
		
		if (htmlRequest.body.postText)
		{
			postText = postText + htmlRequest.body.postText;
		}
		
		//attempt to parse response text, and pull IDs/URLs/hashes if valid
		try
		{
			var dataObject = JSON.parse(postText);

			//add IDs to peer nodes
			if (dataObject.hasOwnProperty("IDs") && Array.isArray(dataObject("IDs")))
			{
				dataObject["IDs"].forEach(function (element, elementNumber){
					if (element.length === 46)
					{
						addToPeerNodes(element);
						console.log("added ID from post");
					}
				});
			}

			if (dataObject.hasOwnProperty("Servers") && Array.isArray(dataObject["Servers"]))
			{
				dataObject["Servers"].forEach(function (element, elementNumber){
					//pull URLs from element and do (bad) verification at the same time
					var newURLmatch = element.match(/(((https?:\/\/)?(([\da-z\.-]+)\.([a-z\.]{2,6})))(:(\d+))?)([\/\w \.-]*)/g);

					if (newURLmatch)
					{
						newURLmatch.forEach(function(site, siteNumber) {
							var siteNormalized = site.replace(/(((https?:\/\/)?(([\da-z\.-]+)\.([a-z\.]{2,6})))(:(\d+))?)([\/\w \.-]*)*\/?/, "$1");
							var protocol = "";

							siteNormalizedMatches = siteNormalized.match(/(((https?:\/\/)?(([\da-z\.-]+)\.([a-z\.]{2,6})))(:(\d+))?)([\/\w \.-]*)*\/?/);

							if (siteNormalizedMatches[3] !== "https://" && siteNormalizedMatches[3] !== "http://")
							{
								siteNormalized = "http://" + siteNormalized;
							}

							peerSitesList.push(siteNormalized);
						});

						//remove duplicates
						peerSitesList = filterDuplicates(peerSitesList);

						console.log(JSON.stringify(peerSitesList));
						console.log("added site from post");
					}
				});
			}

			if (dataObject.hasOwnProperty("Blocks") && Array.isArray(dataObject["Blocks"]))
			{
				dataObject["Blocks"].forEach(function (element, elementNumber){
					if (element.length === 46)
					{
						blocksToMerge.push(element);
						console.log("added block from post");
					}
				});
			}

			if (dataObject.hasOwnProperty("Posts") && Array.isArray(dataObject["Posts"]))
			{
				dataObject["Blocks"].forEach(function (element, elementNumber){
					if (element.length === 46)
					{
						postsToMerge.push(element);
						console.log("added post from post");
					}
				});
			}
		}
		catch (e)
		{
			console.log(e);
		}
		
		ipfs.add(new Buffer(postText.toString()), function(err, res) {
			if(err || !res)
			{
				responseObject["err"] = "Error adding post text to IPFS";
				
				htmlResponse.end(JSON.stringify(responseObject));
				
				//TODO: save text for later upload
				
				return console.error(err);
			}
			
			
			var textResponseArray = [];
			
			var textResponse = res;
			
			
			textResponse.forEach(function(text, textNumber) {
				if (text.hasOwnProperty("Hash"))
				{
					postsToMerge.push(text["Hash"]);
					responseObject["t"] = text["Hash"];
				}
			});
			
			
			
			htmlResponse.end(JSON.stringify(responseObject));
			
			
			if (lastBlockRefresh < Date.now())
			{
				lastBlockRefresh = Date.now() + 10 * 1000
				//temporarily step up refresh block rate to get new posts into circulation
				setTimeout(createBlockCallback, 10 * 1000);
			}
		});
		
	});
	
	app.get('/upload.html', function(req, res) {
		//TODO: add upload.html to IPFS occasionally and store hash to redirect to
		res.sendFile('upload.html', { root: __dirname + "/../client/"});
	});
	
	app.get(/upload/, function(req, res) {
		res.writeHead(302, {
			'Location': 'http://' + req.get('host') + '/upload.html'
			//add other headers here...
		});
		res.end();
	});
	
	app.get(/status/, function(request, response) {
		if (request.headers.origin)
		{
			if (!(request.headers.origin === ""))
			{
				//TODO: check if origin is spamming, in which case don't add this header or deny the request
				response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
			}
		}
		
		//add at least one post (only the empty hash) so that /status always has content
		if (!newestBlock)
		{
			postsToMerge.push("QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
		}
		
		var responseObject = {};
		
		responseObject["block"] = newestBlock.toString();
		responseObject["id"] = ownID.toString();
		
		response.end(JSON.stringify(responseObject));
	});
	
	app.get(/ipfs\/(.*)/, function(request, response) {
		var htmlResponse = response;
		var htmlRequest = request;
		
		//second regex is to find if there are still slashes remaining, meaning the regex should have failed
		var requestedHash = htmlRequest.originalUrl.toString().replace(/\/ipfs\/([\w]{46})(.*)/, "$1").replace(/.*(\/).*/, "$1");
		
		if (requestedHash.length !== 46)
		{
			if (requestedHash.length < 46)
			{
				htmlResponse.end("<html><body><p>that IPFS hash identifier probably is too short</p></body></html>");
			}
			else
			if (requestedHash.length > 46)
			{
				htmlResponse.end("<html><body><p>that IPFS hash identifier is too long</p></body></html>");
			}
			else
			{
				htmlResponse.end("<html><body><p>that IPFS hash identifier is invalid</p></body></html>");
			}
		}
		else
		{
			ipfs.cat(requestedHash, function(err, res) {
				if(err || !res)
				{
					htmlResponse.end("<html><body><p>sorry, something went wrong. It's possible that no known IPFS nodes are up, in which case it would be impossible for your file to be served from this site</p></body></html>");
					return console.error(err);
				}
				
				if(res.readable)
				{
					// Returned as a stream
					var string = '';
					res.on('data', function(chunk) {
						string += chunk;
					});
					
					res.on('end', function() {
						shouldItBeFile(string, htmlResponse, htmlRequest);
					});
				}
				else
				{
					// Returned as a string
					shouldItBeFile(res, htmlResponse, htmlRequest);
				}
			});
		}
	});
	
	app.get(/.*/, function(req, res) {
		var HTMLrequest = req;
		var HTMLresponse = res;
		
		//add aes.js to ipfs
		fs.readFile(__dirname + "/../client/aes.js", function (err, data) {
			if (err)
			{
				console.log("Error reading aes.js");
				
				HTMLresponse.writeHead(302, {
					'Location': 'http://' + req.get('host') + '/upload.html'
					//add other headers here...
				});
				
				//just write something so that onion.city works
				//TODO: does the empty string count?
				HTMLresponse.end("Sorry, but the aes.js library cannot be found. Redirecting you to the generic upload page");
				
				return console.log(err);
			}
			
			ipfs.add(new Buffer(data.toString()), function(err, res) {
				if(err || !res)
				{
					console.log("error adding aes.js to IPFS");
					
					HTMLresponse.writeHead(302, {
						'Location': 'http://' + req.get('host') + '/upload.html'
						//add other headers here...
					});
					
					//just write something so that onion.city works
					//TODO: does the empty string count?
					HTMLresponse.end("Sorry, but something seems to be wrong with the aes javascript file or my IPFS connection. Redirecting you to the generic upload page");
					
					return console.error(err);
				}
				
				//add index.html to ipfs and redirect client to that object
				fs.readFile(__dirname + "/../client/index.html", function (err, data) {
					if (err)
					{
						console.log("Error reading index.html");
						
						HTMLresponse.writeHead(302, {
							'Location': 'http://' + req.get('host') + '/upload.html'
							//add other headers here...
						});
						
						//just write something so that onion.city works
						//TODO: does the empty string count?
						HTMLresponse.end("Sorry, but the index page cannot be found. Redirecting you to the generic upload page");
						
						return console.log(err);
					}
					
					ipfs.add(new Buffer(data.toString()), function(err, res) {
						if(err || !res)
						{
							console.log("error adding index.html to IPFS");
							
							HTMLresponse.writeHead(302, {
								'Location': 'http://' + req.get('host') + '/upload.html'
								//add other headers here...
							});
							
							//just write something so that onion.city works
							//TODO: does the empty string count?
							HTMLresponse.end("Sorry, but something seems to be wrong with the index page or my IPFS connection. Redirecting you to the generic upload page");
							
							return console.error(err);
						}
						
						//add at least one post (only the empty hash) so that /status always has content
						if (!newestBlock)
						{
							postsToMerge.push("QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
						}
						
						var IPFSResponse = res;
						
						
						return IPFSResponse.forEach(function(element, elementNumber) {
							if (element.hasOwnProperty("Hash"))
							{
								console.log("redirecting index to " + "/ipfs/" + element["Hash"].toString());
								
								HTMLresponse.writeHead(302, {
									'Location': 'http://' + req.get('host') + '/ipfs/' + element["Hash"].toString()
									//add other headers here...
								});
								
								//just write something so that onion.city works
								//TODO: does the empty string count?
								return HTMLresponse.end("");
							}
						});
					});
				});
			});
		});
	});
	
	app.get(/boop/, function(request, response) {
		response.end("boop");
	});
	
	var server = app.listen(app.get('port'), function() {
		console.log('Node app is running on port', app.get('port'));
	});

	//TODO: make this dependent on a config variable
	//make POST request to built in servers with own node ID
	postIDToServers();
	
	process.on('SIGTERM', function () {
		console.log("Received SIGTERM. Closing server with orders to exit process afterwards");
		server.close(quit);
		delayKill(3);
	});
	
	process.on('SIGINT', function () {
		//make sure there's a newline after the ^C character
		console.log();
		console.log("Received SIGINT. Closing server with orders to exit process afterwards");
		server.close(quit);
		delayKill(2);
	});
}


main();
