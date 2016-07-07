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


//control to fill mailboxCreationTimes up with dummy values at startup to increase refresh rate or not
var startQuick = true;
//control what the minimum and maximum block creation time is, in miliseconds
var minimumBlockTime = 10 * 1000; //ten seconds
var maximumBlockTime = 60 * 60 * 1000; //one hour
//set target for number of blocks per hour
var targetBlocksPerHour = 6;

//track when emergency refreshes are allowed to prevent minting in /uploaded from triggering multiple times
var lastMailboxRefresh = 0;

var newestMailbox = "";

//list of peer sites
var postsToMerge = [];
var mailboxesToMerge = [];
var mailboxes = [];
var foreignMailboxes = [];
var userSubmittedHashes = [];
var mailboxCreationTimes = [];
//blank entries are to give the site respite if it has itself in its array
var peerSitesList = ["https://ipfschan.herokuapp.com"];

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

function cleanMailboxCreationTimes(callback)
{
	if (!callback)
	{
		callback = function(){return true;};
	}
	
	var currentTime = Date.now();
	//remove all dates older than one hour
	while(mailboxCreationTimes[0] < currentTime - (60 * 60 * 1000))
	{
		mailboxCreationTimes.splice(0, 1);
	}
	
	return callback();
}

function refreshMailboxResponse (response)
{
	var str = '';
	
	//another chunk of data has been recieved, so append it to `str`
	response.on('data', function (chunk) {
		str += chunk;
	});
	
	//the whole response has been recieved, so we just print it out here
	response.on('end', function () {
		console.log("string received from foreign host: " + str);
		
		//if foreignNewest is really an IPFS hash
		//TODO: better checking
		if (str.length === 46)
		{
			//only process if foreign newest is actually new (foreign site is active)
			if (foreignMailboxes.indexOf(str) === -1)
			{
				foreignMailboxes.push(str);
				mailboxesToMerge.push(str);
			}
		}
		else
		{
			console.log("invalid IPFS hash received from foreign host");
			//TODO: add a failure to a list for this host and reorganize the list to put sites with the largest number of bad responses at the end
			//TODO: scrape result for new URLs
		}
	});
}

function refreshMailbox(site)
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
			var req = protocol.request(site + "/newest", refreshMailboxResponse);
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
	
	cleanMailboxCreationTimes(function(){
		if (currentPeerSite >= peerSitesList.length || currentPeerSite < 0)
		{
			currentPeerSite = 0;
		}
		
		
		if (peerSitesList.length > 0)
		{
			refreshMailbox(peerSitesList[currentPeerSite]);
		}
		
		//delay devided by 2 to be twice as fast
		var delay = Math.ceil((Math.min(maximumBlockTime, Math.ceil(((60 * 60 * 1000 / targetBlocksPerHour) - minimumBlockTime) * ((mailboxCreationTimes.length) / targetBlocksPerHour) + minimumBlockTime)) + 1) / 2);
		
		return setTimeout(refreshPeerSite, delay, currentPeerSite + 1);
	});
}

function createMailboxCallback()
{
	//clean mailboxesToMerge of mailboxes created by this server
	//this will prevent mailboxes downloaded from yourself from being re-added
	for (var i = 0; i < mailboxesToMerge.length; i++)
	{
		if (mailboxes.indexOf(mailboxesToMerge[i]) !== -1)
		{
			mailboxesToMerge.splice(i, 1);
		}
	}
	
	//only run if there is something to commit
	if (mailboxesToMerge.length > 0 || postsToMerge.length > 0 || userSubmittedHashes.length > 0)
	{
		var newMailboxJSON = {};
		var oldMailbox = newestMailbox.toString();
		
		
		//if there are no new mailboxes, don't include an ["o"] entry (this is mostly for startup when there is no newest mailbox)
		//TODO: check if this mailbox chain gets to new posts before getting back to all previously included mailboxes
		if (mailboxesToMerge.length > 0 || oldMailbox)
		{
			newMailboxJSON["o"] = mailboxesToMerge;
			mailboxesToMerge = [];
			
			if (oldMailbox)
			{
				newMailboxJSON["o"].push(oldMailbox);
			}
			
			//remove duplicates
			newMailboxJSON["o"] = newMailboxJSON["o"].filter(function(element, position, array) {
				return array.indexOf(element) === position;
			});
			
			if (newMailboxJSON["o"].length <= 0)
			{
				delete newMailboxJSON["o"];
			}
		}
		
		if (postsToMerge.length > 0)
		{
			newMailboxJSON["n"] = postsToMerge;
			
			postsToMerge = [];
			
			//remove duplicates
			newMailboxJSON["n"] = newMailboxJSON["n"].filter(function(element, position, array) {
				return array.indexOf(element) === position;
			});
			
			if (newMailboxJSON["n"].length <= 0)
			{
				delete newMailboxJSON["n"];
			}
		}
		
		if (userSubmittedHashes.length > 0)
		{
			newMailboxJSON["u"] = userSubmittedHashes;
			
			userSubmittedHashes = [];
			
			//remove duplicates
			newMailboxJSON["u"] = newMailboxJSON["u"].filter(function(element, position, array) {
				return array.indexOf(element) === position;
			});
			
			if (newMailboxJSON["u"].length <= 0)
			{
				delete newMailboxJSON["u"];
			}
		}
		
		//only mint new if there are new posts or a merged chain
		if ((newMailboxJSON.hasOwnProperty("n") && newMailboxJSON["n"].length > 0) || (newMailboxJSON.hasOwnProperty("o") && newMailboxJSON["o"].length > 1))
		{
			var newMailbox = JSON.stringify(newMailboxJSON).toString();
			
			
			console.log(newMailbox);
			
			
			ipfs.add(new Buffer(newMailbox.toString()), function(err, res) {
				if(err || !res)
				{
					return console.error(err);
				}
				
				var mailboxResponse = res;
				
				
				mailboxResponse.forEach(function(element, elementNumber) {
					//store new mailbox hash in core directory
					newestMailbox = element.Hash.toString();
					
					mailboxes.push(newestMailbox);
					
					//push to IPFS node
					publishMailboxPush();
					
					//write to file to restore on restart
					writeIfNotExist("/tmp/IPFSchan/mailbox/newest/newest.txt", "", function(){
						fs.writeFile("/tmp/IPFSchan/mailbox/newest/newest.txt", newestMailbox, function (err) {
							if (err)
							{
								console.log(err);
							}
						});
					});
					
					var currentTime = Date.now();
					
					mailboxCreationTimes.push(currentTime);
				});
			});
		}
	}
}

function createMailbox()
{
	//clean mailboxCreationTimes
	return cleanMailboxCreationTimes(function(){
		createMailboxCallback();
		
		//create new mailbox slower if there are many blocks recently, faster if there are few
		//all in milliseconds, the average block time minus the minimum, times the target number of blocks devided by the actual number of blocks, plus the minimum block time, plus one
		//average block time is calculated by taking one hour in miliseconds and deviding it by the target blocks per hour
		//minimum time is subtracted from average time so that if the number of blocks is equal to the target, the final sum is equal to averageBlockTime
		//mailboxCreationTimes.length / targetBlocksPerHour is equal to one if the target is met, approaches zero as the number of blocks dwindles, and approaches infinity as the number of blocks increase
		//always add one at the very end to prevent a delay of zero
		var delay = Math.min(maximumBlockTime, Math.ceil(((60 * 60 * 1000 / targetBlocksPerHour) - minimumBlockTime) * ((mailboxCreationTimes.length) / targetBlocksPerHour) + minimumBlockTime)) + 1;
		
		
		return setTimeout(createMailbox, delay);
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
		if (!newestMailbox)
		{
			newestMailbox = data.toString();
		}
		else
		{
			mailboxesToMerge.push(data.toString());
		}
	}
	
	console.log("newestMailbox: " + newestMailbox);
	console.log("JSON.stringify(mailboxesToMerge) " + JSON.stringify(mailboxesToMerge));
}

function addToPeerSites(newArr)
{
	var tempArr = peerSitesList;
	
	for(var i = 0; i < newArr.length; i++)
	{
		tempArr.push(newArr[i]);
	}
	
	//remove duplicates
	tempArr = tempArr.filter(function(element, position, array) {
		return array.indexOf(element) === position;
	});
	
	//remove blanks
	tempArr = tempArr.filter(function(element, position, array) {
		if (element.length === 0)
		{
			return false;
		}
		return true;
	});
	
	peerSitesList = tempArr;
}

function publishMailboxPull(callback)
{
	var addResultToLists = false;
	
	if (!callback)
	{
		callback = function(){};
		addResultToLists = true;
	}
	
	var publishedObject = {};
	
	var finishPublish = function (str, callback){
		try
		{
			publishedObject = JSON.parse(str);
			
			if (addResultToLists)
			{
				maybeAddAsNewest(publishedObject["IPFSchan"]["newestMailbox"]);
				addToPeerSites(publishedObject["IPFSchan"]["peerSites"]);
			}
		}
		catch (e)
		{
			console.log(e);
		}
		
		callback(publishedObject);
	};
	
	ipfs.id(function(err, res){
		if (err)
		{
			return console.log(err);
		}
		
		var IDresponse = res;
		
		console.log("response ID: " + res["ID"]);
		
		
		ipfs.name.resolve(IDresponse["ID"], function(err, res){
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
	});
}

function publishMailboxPush()
{
	//pull current object to preserve unrelated information
	publishMailboxPull(function(publishedObject){
		if (!publishedObject)
		{
			publishedObject = {};
		}
		
		var publishObject = publishedObject;
		
		publishObject["IPFSchan"] = {};
		
		publishObject["IPFSchan"]["newestMailbox"] = newestMailbox;
		publishObject["IPFSchan"]["peerSites"] = peerSitesList.filter(function(element, position, array){
			return array.indexOf(element) === position;
		}).filter(function(element, position, array){
			return !(element === "");
		});
		
		ipfs.add(new Buffer(JSON.stringify(publishObject).toString()), function(err, res) {
			if(err || !res)
			{
				return console.error(err);
			}
			
			
			res.forEach(function(text, textNumber) {
				ipfs.name.publish(text["Hash"], function(err, res){
					if (err)
					{
						return console.log(err);
					}
					
					console.log("published object: " + JSON.stringify(res));
				});
			});
		});
	});
}

function quit()
{
	console.log("Server closed. Exiting process");
	process.exit(0);
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
	
	
	//fill mailboxCreationTimes with dummy values to create baseline
	var currentTime = Date.now();
	//only if global variable is set
	if (startQuick)
	{
		for (var i = 0; i < targetBlocksPerHour; i++)
		{
			mailboxCreationTimes.push(currentTime + i * 60 * 1000);
		}
	}
	
	
	//fill cfgObject with defaults
	if (!cfgObject.hasOwnProperty("ipfsAPI"))
	{
		cfgObject["ipfsAPI"] = {};
	}
	
	if (!cfgObject["ipfsAPI"].hasOwnProperty("domain") || cfgObject["ipfsAPI"]["domain"] === "")
	{
		cfgObject["ipfsAPI"]["domain"] = "localhost";
	}
	
	if (!cfgObject["ipfsAPI"].hasOwnProperty("port")  || cfgObject["ipfsAPI"]["port"] === "")
	{
		cfgObject["ipfsAPI"]["port"] = "5001";
	}
	
	if (!cfgObject["ipfsAPI"].hasOwnProperty("options"))
	{
		cfgObject["ipfsAPI"]["options"] = {protocol: 'http'};
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
	
	
	console.log("final config object: " + JSON.stringify(cfgObject));
	
	
	fs.readFile("/tmp/IPFSchan/mailbox/newest/newest.txt", function (err, data) {
		if (err)
		{
			console.log("Error reading file that stores initial mailbox");
			return console.log(err);
		}
		maybeAddAsNewest(data.toString());
		console.log("newestMailbox: " + newestMailbox);
	});
	
	
	app = express();
	ipfs = ipfsAPI(cfgObject["ipfsAPI"]["domain"], cfgObject["ipfsAPI"]["port"], cfgObject["ipfsAPI"]["options"]);
	
	
	publishMailboxPull();
	
	
	//add at least one post (only the empty hash) so that /newest always has content
	postsToMerge.push("QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
	
	if (lastMailboxRefresh < Date.now())
	{
		lastMailboxRefresh = Date.now() + 10 * 1000
		setTimeout(createMailboxCallback, 10 * 1000);
	}
	
	
	
	//start auto-refresh from peer sites
	refreshPeerSite();
	//start creating mailboxes
	createMailbox();
	
	
	
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
		
		//scrape postText for URLs and add them to peerSitesList
		//TODO: better URL regex
		var newURLmatch = postText.match(/(((https?:\/\/)?(([\da-z\.-]+)\.([a-z\.]{2,6})))(:(\d+))?)([\/\w \.-]*)*\/?/g);
		
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
			peerSitesList = peerSitesList.filter(function(element, position, array) {
				return array.indexOf(element) === position;
			});
			
			console.log(JSON.stringify(peerSitesList));
		}
		
		//IPFS hash scraper
		//disabled: trying to load hashes that aren't real causes problems in the client
		/*
		var IPFSHashMatch = postText.match(/[\w]{46}/g);
		
		if (IPFSHashMatch)
		{
			IPFSHashMatch.forEach(function(hash, matchNumber) {
				//TODO: add to "unknown" list for adding to mailboxes
				userSubmittedHashes.push(hash);
			});
		}
		/**/
		
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
				postsToMerge.push(text["Hash"]);
				responseObject["t"] = text["Hash"];
			});
			
			
			
			htmlResponse.end(JSON.stringify(responseObject));
			
			
			if (lastMailboxRefresh < Date.now())
			{
				lastMailboxRefresh = Date.now() + 10 * 1000
				//temporarily step up refresh mailbox rate temporarily to get new posts into circulation
				setTimeout(createMailboxCallback, 10 * 1000);
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
	
	app.get(/newest/, function(request, response) {
		if (request.headers.origin)
		{
			if (!(request.headers.origin === ""))
			{
				//TODO: check if origin is spamming, in which case don't add this header or deny the request
				response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
			}
		}
		
		//add at least one post (only the empty hash) so that /newest always has content
		postsToMerge.push("QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
		
		response.end(newestMailbox.toString());
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
		
		//TODO: add aes.js to ipfs
		fs.readFile(__dirname + "/../client/aes.js", function (err, data) {
			if (err)
			{
				console.log("Error reading aes.js");
				
				HTMLresponse.writeHead(302, {
					'Location': 'http://' + req.get('host') + '/upload.html'
					//add other headers here...
				});
				
				//TODO: just write something so that onion.city works
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
					
					//TODO: just write something so that onion.city works
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
						
						//TODO: just write something so that onion.city works
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
							
							//TODO: just write something so that onion.city works
							//TODO: does the empty string count?
							HTMLresponse.end("Sorry, but something seems to be wrong with the index page or my IPFS connection. Redirecting you to the generic upload page");
							
							return console.error(err);
						}
						
						//add at least one post (only the empty hash) so that /newest always has content
						postsToMerge.push("QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
						
						var IPFSResponse = res;
						
						
						return IPFSResponse.forEach(function(element, elementNumber) {
							console.log("redirecting index to " + "/ipfs/" + element.Hash.toString());
							
							HTMLresponse.writeHead(302, {
								'Location': 'http://' + req.get('host') + '/ipfs/' + element.Hash.toString()
								//add other headers here...
							});
							
							//TODO: just write something so that onion.city works
							//TODO: does the empty string count?
							return HTMLresponse.end("");
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
	
	process.on('SIGTERM', function () {
		console.log("Received SIGTERM. Closing server with orders to exit process afterwards");
		server.close(quit);
	});
	
	process.on('SIGINT', function () {
		//make sure there's a newline after the ^C character
		console.log();
		console.log("Received SIGINT. Closing server with orders to exit process afterwards");
		server.close(quit);
	});
}


main();
