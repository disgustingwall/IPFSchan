# IPFSchan
Distributed messageboard

## Usage:

IPFSchan can be used at several different levels: user, archivalist, or server operator. Each usage level builds on the last, and every step you take makes you a more effective participant. 

### Level 1: User

The very act of using IPFSchan is helpful. Files are served through the IPFS network, meaning they are backed up on the server the client is using, the server where the content was posted, and every node that connects the two. 

This level of usage doesn't require any technical skills. Simply access a functioning server (such as [https://ipfschan.herokuapp.com](https://ipfschan.herokuapp.com)) and browse to your heart's content. Everything you view is automatically backed up on the IPFS network. 

### Level 2: Archivalist

This level of usage requires some technical know-how, but not much. 

Since all content is stored on nodes of the IPFS network, setting up your own node and using it for browsing allows you to save the content you view to your own computer automatically. 

To set up your own node, go to [https://ipfs.io/docs/install/](https://ipfs.io/docs/install/) and install an IPFS node on your computer. 

The correct choice for you depends on your operating system and trust level of precompiled binaries, but I personally use the precompiled 64 bit linux binary. Installation instructions should be on the download page and in the file you download. 

Once you've installed an IPFS node, start it up. on linux, this is done through running the command `ipfs daemon` on a terminal. 

You may be prompted to initialize your IPFS cache if you have recently installed IPFS or something has gone wrong. Know that this is fine as long as you have never loaded any content through IPFS, but doing so while you have content stored locally will delete it permanently! 

Once you have set up your IPFS node and have it running, navigate to a functioning server (such as [https://ipfschan.herokuapp.com](https://ipfschan.herokuapp.com)). Once the page loads, change the domain to `localhost:8080`. If your IPFS node is set up correctly, the page should reload after a delay and should look exactly the same. Now when you view a post, it will be downloaded directly to your computer and saved there. 

Your web browser will still query for new content directly from another server, but the content you view is saved on your own machine, meaning it is safe from network problems or deletion. 

Note that IPFS sometimes cleans its cache of content that hasn't been accessed recently as the cache grows. This is normal behavior, but be aware that your local archive is not permanent. If you want to permanently archive your data, you must take extra steps to make backups of your IPFS cache or save content you find interesting. 

### Level 3: Server Operator

This level of usage has more significant setup time, but the main requirements are still rather easy to accomplish. 

Running a server means that you can submit new content to IPFSchan without using an outside server. That content will be compiled into blocks automatically, and references to those blocks will be copied and hosted by other servers. 

The server software is located at `app/server/server.js` in this repository. To run this file, you must install nodeJS and update it to version 4.0.0 or greater. 
To run the server on linux, run the command `node ./app/server/server.js` from a terminal where the current directory is the IPFSchan project's root folder. This will start the server, available at [http://localhost:12462](http://localhost:12462).

However, there are additional setup steps required at this point. Mainly, you must tell your server of a functioning IPFS node to use. If you have set up an IPFS node in level 2 above on the same machine as the server, that will work without extra configuration. If you have a node set up on another server, you will need to set the environment variables "IPFShostname" or "IPFSip", and "IPFSport". IPFSport should probably be 5001, but IPFShostname or IPFSip need to be the hostname or ip of your IPFS node that is accessible by your server. For example, your IPFSip setting might be "198.51.100.0" if that were the ip of your IPFS node, or "mynode.example.org" if you're using a DNS service, or some other configuration that resolves to an ip. To do this one a single line, enter the following command with your own information included: `IPFSip=192.168.1.32 IPFSport=5001 node ./app/server/server.js`

If you have set up an IPFS node in level 2 above on the same machine as the server, that will work with the default configuration. 

If you have a node set up on another server, you will need to set the environment variables `IPFShostname` or `IPFSip`, and `IPFSport`. `IPFSport` should probably be 5001, but `IPFShostname` or `IPFSip` need to be the hostname or ip of your IPFS node that is accessible by your server. For example, your IPFSip setting might be `192.0.2.0` if that were the IP of your IPFS node, or `mynode.example.org` if you're using a DNS service, or some other configuration that resolves to an IP. 

To set these variables and start the server on a single line, enter the following command with your own information included: `IPFSip=192.0.2.0 IPFSport=5001 node ./app/server/server.js`

This will allow the server to post to the IPFS network.

If you have altered the configuration file and removed all servers from it, you will need to manually share your server's hostname, IP, or IPFS node ID so that other servers will merge your users' data with its own. 

In order to accomplish this, you must post your server's address on other servers. However, this is not done through the normal posting page, since parsing every post for data has resulted in many false positives. To tell your server to pull from another server, navigate to [http://localhost:12462/upload.html](http://localhost:12462/upload.html) and enter a JSON block containing the foreign server's address, like so:

    {"Servers":["https://ipfschan.herokuapp.com"]}

upload.html doesn't change or package what you enter in any way, so anything you post will be read by the server in exactly that form. 

Do the same on the foreign server you want to pull from your server: go to the server's upload.html page, and in the text box enter your server's publicly available hostname or ip, including any port requirements (if port 80, it's optional), like so: 

    {"Servers":["http://192.0.2.0:8080"]}

Be sure to include any nesecary port numbers. 

The two servers should now pull blocks from each other periodically and merge their content listings. 

#### Sharing more data

You can also share other data with servers this way. Most information will propagate between servers if they can successfully load each other's pages, but this can offer an alternate way to start sharing data, or allow people running nodes, but not servers, to add blocks and posts. 

The server also parses the following tags: `IDs`, `Blocks`, and `Posts`. These share IPFS objects rather than web URLs. 

Here's an example of all the tags in use: 

    {"IDs":["QmTJvweGd7xBhfz1pPQYbrbPGrFT1A8aZWCFXDZyTdJYQR"], "Servers":["https://example.org"], "Blocks":["QmT5Hf1LyA1USWZfHX45NdCn4bUUmW3fAthgfbNnFJ6Amh"], "Posts":["QmT5Hf1LyA1USWZfHX45NdCn4bUUmW3fAthgfbNnFJ6Amh"]}

##### IDs

Sharing an ID with a server will cause that server to pull data directly from the corresponding IPFS node through a process called publishing. 

An IPFS node can list an IPFS object that is referred to by its ID. IPFSchan uses this feature to store a reference to the most updated post directory, as well as other sites and nodes it knows about. 

Because of this, giving a server your IPFS node ID will allow it to download your server's post directory and other data completely within the IPFS network. 

##### Blocks and Posts

If you publish a post or create a block on your own, you can tell a server to add that to the public directory through these tags. 

##### Additional notes

Every tag actually contains an array, so you can send multiple objects to a server at once: 

    {Servers: ["example.net", "example.org"]}
