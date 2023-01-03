/*
frontend.js - bedrock-viz GUI front end
by Alex Matulich
v1.0, 29 April 2022

This application requires node.js.
Download the Windows installer from https://nodejs.org/en/download/
After installing node.js, add the path to node.exe to your %PATH%
environment variable.

Once you have installed node.js, start this bedrock-viz front-end application
like this:

> cd [your bedrock-viz folder]
> node frontend.js

Then, from your browser, access the app using the address
localhost:3333

That's it! When you create a map, the bedrock-viz output appears in the
commandline console window from which you started the app.
*/

// ---------- VALUE INITIALIZATIONS ----------

const http = require('http') // http server features
const fs = require('fs') // local file handling
const os = require('os') // operating system specific functions
const util = require('util') // util functions
const path = require('path') // basic path name parsing
const { spawn } = require('child_process') // this is what we use to invoke bedrock-viz

const PORT = 3333 // http port to use
let lastIP = '0' // last IP address seen
let worlds = [] // array of world objects

// directory locations
const worldPath = process.env.WORLDS_PATH || '/tmp/worlds' // where our worlds are stored (can and should be readonly)
const mapsPath = process.env.MAPS_PATH || '/tmp/maps' // where our maps get stored
const managementKey = process.env.MANAGEMENT_KEY // management key for enabling management functions

// logging initialization
const funcs = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console)
}

/**
 * @param {function|string} fn
 */
function logPrefix (fn) {
  Object.keys(funcs).forEach(function (k) {
    console[k] = function () {
      const s = typeof fn === 'function' ? fn() : fn
      arguments[0] = util.format(s, arguments[0])
      funcs[k].apply(console, arguments)
    }
  })
}

/**
 * @param {function|string} [prefix] prefix
 */
function patch (prefix) {
  if (typeof prefix === 'function') {
    logPrefix(prefix)
  } else if (typeof prefix === 'string' && prefix) {
    logPrefix(() => prefix + ' ' + timestamp())
  } else {
    logPrefix(timestamp)
  }
}

/**
 * @returns {string}
 */
function timestamp () {
  return '[' + new Date().toISOString() + ']'
}

patch()

// ---------- CODE INITIALIZATIONS ----------

// if worldPath doesn't exist...
if (!fs.existsSync(worldPath)) {
  console.log(`Fatal error: Unable to read ${worldPath}`)
  process.abort()
}

// if mapsPath doesn't exist...
if (!fs.existsSync(mapsPath)) {
  try {
    fs.mkdirSync(mapsPath)
  } catch (err) {
    console.log(`Fatal error: Unable to create ${mapsPath}`)
    process.abort()
  }
}

// populate worlds[] array
refreshWorlds()

/*
Static file and dynamic content server loop:
* Files that exist in the 'mapsPath' path are served.
* If the path is "/thumbnails/<icon_name>.jpg" then the icon found in "'worldPath'/icon_name/world_icon.jpeg" is served.
* If the path is "/" or "/index.html" then the output is dynamic, and the content depends on whether the user is local or remote.
Local users can create and delete bedrock-viz maps, and make them public or private.
Remote users can only view public maps.
*/

const server = http.createServer(function (request, response) {
  let isManagementUser = false
  const ip = (request.headers['x-forwarded-for'] || '').split(',')[0] || request.connection.remoteAddress
  if (ip === '::1' || ip === 'ffff:127.0.0.1' || ip === '127.0.0.1') {
    isManagementUser = true
  }
  const cookies = parseCookies(request)
  if (managementKey && cookies.MANAGEMENTKEY === managementKey) {
    isManagementUser = true
  }
  if (ip !== lastIP) {
    // display log message only if IP address changes
    console.log(`IP address=${ip}`, isManagementUser ? ' local' : ' remote')
    lastIP = ip
  }

  let url = request.url.replace(/^(\.)+/, '.') // for security, prevent paths like ../../../ to get to root
  if (url === '/') url = '/index.html'
  const filePath = (url.indexOf('thumbnails') > 0)
    ? worldPath + '/' + path.basename(url, '.jpg') + '/world_icon.jpeg'
    : mapsPath + url

  const extname = String(path.extname(filePath)).toLowerCase()
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',

    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.woff': 'application/font-woff',
    '.ttf': 'application/font-ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'application/font-otf',
    '.wasm': 'application/wasm'
  }

  const contentType = mimeTypes[extname] || 'application/octet-stream'

  let poststring
  if (request.method === 'POST') {
    poststring = ''
    // get POST data
    request.on('data', function (chunk) {
      poststring += chunk
    })
    // process POST data
    request.on('end', function () {
      const params = new URLSearchParams(poststring)
      // operation to perform (newmap, delete, html_buttonPublicToggle)
      const op = params.get('op')
      // which map to perform it on
      const mapname = params.get('mapname')
      const scrollposparm = params.get('scrollpos')
      const scrollpos = (scrollposparm === null) ? 0 : Number(scrollposparm)

      if (op === 'newmap') {
        const mapdetail = params.get('mapdetail')
        const outputDirectory = mapsPath + '/' + mapname

        const tmpDir = `${os.tmpdir()}${path.sep}`
        const sourceDirectory = worldPath + '/' + mapname
        const workingDirectory = fs.mkdtempSync(tmpDir)

        console.log(`Working directory: ${workingDirectory}`)
        fs.cpSync(sourceDirectory, workingDirectory, { recursive: true })
        console.log(`COPIED ${sourceDirectory} to ${workingDirectory}`)

        deleteMap(mapname)
        // invoke bedrock-viz
        const bedrockViz = spawn('bedrock-viz', ['--db', workingDirectory, '--out ', outputDirectory, mapdetail], {
          shell: true,
          cwd: __dirname
        })
        bedrockViz.stdout.on('data', data => {
          console.log(`stdout: ${data}`)
        })
        bedrockViz.stderr.on('data', data => {
          console.log(`stderr: ${data}`)
        })
        bedrockViz.on('error', (error) => {
          console.log(`error: ${error.message}`)
          fs.rmSync(workingDirectory, { recursive: true, force: true })
          console.log(`DELETED ${workingDirectory}`)
        })
        bedrockViz.on('exit', code => {
          console.log(`bedrock-viz exited with code ${code}`)
          if (code === 0) {
            // created map successfully
            // write some additional json data into the map's folder for later retrieval
            const wname = params.get('worldname')
            const publicmap = (params.get('publicmap') !== 'false')
            writeMetafile({ name: mapname, worldname: wname, mapdetail, publicmap })
          }
          response.writeHead(200, { 'Content-Type': contentType })
          response.end(makeMapList(isManagementUser, '', scrollpos), 'utf-8')
          fs.rmSync(workingDirectory, { recursive: true, force: true })
          console.log(`DELETED ${workingDirectory}`)
        })
      } else {
        let excludeworld = ''

        if (op === 'delete') {
          deleteMap(mapname)
          // used if asynchronous deletion isn't done when the map list is regenerated
          excludeworld = mapname
        } else if (op === 'html_buttonPublicToggle') {
          const publicmap = params.get('publicmap')
          const k = findWorldIndex(mapname)
          if (k >= 0) {
            worlds[k].publicmap = (publicmap !== 'false')
            writeMetafile(worlds[k])
          }
        } else if (op === 'refresh') {
          refreshWorlds()
        }
        response.writeHead(200, { 'Content-Type': contentType })
        response.end(makeMapList(isManagementUser, excludeworld, scrollpos), 'utf-8')
      }
    })
    // done with POST processing
  } else if (url === '/index.html') {
    // output map list page if '/' or '/index.html' is requested
    response.writeHead(200, { 'Content-Type': contentType })
    response.end(makeMapList(isManagementUser, '', 0), 'utf-8')
  } else {
    // otherwise just process the HTTP GET request normally
    fs.readFile(filePath, function (error, content) {
      if (error) {
        if (error.code === 'ENOENT') {
          response.writeHead(404, { 'Content-Type': 'text/html' })
          response.end('<!DOCTYPE html><html><head></head><body><h1>Error 404: Page not found</body></html>', 'utf-8')
        } else {
          response.writeHead(500)
          response.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n')
        }
      } else {
        response.writeHead(200, { 'Content-Type': contentType })
        response.end(content, 'utf-8')
      }
    })
  }
})
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT} (${JSON.stringify(server.address())})`)
})
console.log(`CWD: ${__dirname}`)

// end of server loop

// ---------- FUNCTIONS ----------
/**
 * Read the Minecraft worlds directory and build a list of relevant information (directory name, location, timestamp)
 */
function refreshWorlds () {
  let stats, world, worldName, i, j
  console.log('getting Minecraft worlds information')
  const files = fs.readdirSync(worldPath)
  if (files.length === 0) return
  worlds = []
  for (i = 0, j = 0; i < files.length; i++) {
    world = worldPath + '/' + files[i] + '/'
    try {
      stats = fs.statSync(world)
    } catch (err) {
      console.log(`Warning: Unable to get information on ${world}`)
      continue
    }
    if (stats.isDirectory()) {
      try {
        worldName = fs.readFileSync(world + 'levelname.txt', 'utf8')
      } catch (err) {
        worldName = 'Unknown'
      }
      worlds[j++] = {
        name: files[i],
        worldname: worldName,
        mtimeMs: stats.mtimeMs,
        mtime: stats.mtime,
        hasmap: false,
        mappable: true,
        mapdetail: '--html-all',
        publicmap: true
      }
    }
    worlds.sort((a, b) => {
      return b.mtimeMs - a.mtimeMs
    })
    console.log(`found following worlds: '${worlds.map(a => a.name).join(',')}'`)
  }
}

/**
 * generate the top of the main HTML page
 * @param {boolean} isManagementUser
 * @returns {string}
 */
function htmlPageTop (isManagementUser) {
  const header = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<title>Minecraft maps from bedrock-viz</title>\n\
<style>\n\
body { background: #060606; color: #ffffffCC; font-size: 16px; font-family:sans-serif; }\n\
a:link, a:visited { color: #00BB00; }\
a:hover { color: #00EEFF; }\n\
a:active { color: yellow; }\n\
.row { display:flex; flex-wrap:wrap; align-items:center; border: 1px solid green; width:99%; padding:0.5em 1em 0.5em 1em; }\n\
.row .image { width:320px; height:180px; border:3px ridge silver; text-align:center; margin:0.5em 1em 0.5em 1em; }\n\
.row .image img {filter: brightness(95%)}\n\
.row .desc { text-align:left; margin: 0.5em; }\n\
.row .desc h2 { margin-top:0; }\n\
form.mapaction { display:inline-block; font-size:larger; }\n\
form.refresh { float:right; margin-right:2em; font-size:larger; }\n\
form.mapaction input, form.mapaction select, form.refresh input { background:#BBDDCC; font-size:inherit; }\n\
form.mapaction div.private { border: 1px solid red; padding:0.1em; background:#550000; }\n\
form.mapaction div.public { border: 1px solid #00FF00; padding:0.1em; background:#005500; }\n\
.date { font-size: smaller; font-style:italic; }\n\
.modal { display:none; align-content:center; position: fixed; z-index:1; left:0; top:0; width:100%; height:100%; background-color:#060606; background-color:rgba(6,6,6,0.5); }\n\
.modal-content { width:150px; height:180px; margin:auto; text-align:center; color:yellow; }\n\
.modal-content img { display:inline-block; }\n\
#footer p { font-size:smaller; text-align:center; }\n\
</style>\n\
<script>\n\
function setscrollpos(id) { document.getElementById(id).value=window.scrollY.toString(); return true; }\n\
function spinner() { document.getElementById('spinner').style.display='flex'; }\n\
function confirmdelete(name,wname) { setscrollpos('d'+name); return confirm('Confirm DELETE the map for \"'+wname+'\".'); }\n\
function confirmcreate(name,wname,repl) { setscrollpos('n'+name); var act = repl ? 'REPLACE map for ' : 'Create new map for '; if(confirm(act+wname+'?')) { spinner(); return true; } else return false; }\n\
function refreshmodal() { spinner(); }\n\
</script>\n\
</head>\n<body>\n<div id=\"content\">"
  return header +
    (isManagementUser ? '<form class="refresh" action="/" method="POST"><input type="hidden" name="op" value="refresh"><input type="submit" value="&#x1F504;&#xFE0F; Refresh world list" title="Click if you played Minecraft since starting the server" onclick="refreshmodal();"></form>' : '') +
    '<h1><img src="https://static.wikia.nocookie.net/minecraft_gamepedia/images/0/09/Minecraft_Twitter_logo.jpeg" style="width:40px; vertical-align:middle;" alt="[logo]"> <cite>Minecraft</cite> maps</h1>\n'
}

/**
 * Generate a row in the worlds table. If the world has a map, link to it. If isManagementUser=true, include buttons to delete the map and create a new map.
 *
 * @param {boolean} isManagementUser
 * @param {*} world
 * @param {string} imgPath
 * @param {Date|number|string} mapTime
 */
function htmlMakeRow (isManagementUser, world, imgPath, mapTime) {
  const indexHtmlPath = world.name + '/index.html'
  let row = '<div class="row' + (world.hasmap ? ' hasmap' : '') + '"><div class="image">'
  row += (world.hasmap ? '<a href="' + indexHtmlPath + '">' + imgPath + '</a>\n' : imgPath) + '</div>\n<div class="desc"><h2>'
  row += (world.hasmap ? '<a href="' + indexHtmlPath + '">' + world.worldname + '</a>' : world.worldname) + '</h2>\n'
  if (world.mappable && isManagementUser) {
    row += htmlButtonNewMap(world)
  }
  row += (world.mtime === 'Unknown' ? '<p class="date">World no longer exists</p>\n' : '<p class="date">World updated: ' + world.mtime + '</p>\n')
  if (world.hasmap) {
    row += '<p class="date">Map updated: ' + mapTime + '</p>\n'
    if (isManagementUser) {
      row += (htmlButtonDelete(world) + htmlButtonPublicToggle(world))
    }
  }
  row += '</div>\n'
  return row + '</div>\n'
}

/**
 * delete button - called by htmlMakeRow()
 * @param {*} world
 * @returns {string}
 */
function htmlButtonDelete (world) {
  return '<form class="mapaction" method="post" action="/"><input type="hidden" name="mapname" value="' +
    world.name + '"><input type="hidden" name="op" value="delete"><input type="hidden" id="d' + world.name + '" name="scrollpos" value="0">' +
    "<input type=\"submit\" value=\"&#x1F5D1;&#xFE0F; Delete map\" onclick=\"return confirmdelete('" +
    world.name + "','" + world.worldname + "');\"></form>\n"
}

/**
 * new map button - called by htmlMakeRow()
 * @param {*} world
 * @returns {string}
 */
function htmlButtonNewMap (world) {
  return '<form class="mapaction" method="post" action="/"><input type="hidden" name="mapname" value="' +
    world.name + '"><input type="hidden" name="op" value="newmap"><input type="hidden" name="worldname" value="' +
    world.worldname + '"><input type="hidden" id="n' + world.name + '" name="scrollpos" value="0"><input type="hidden" name="publicmap" value="' +
    world.publicmap.toString() +
    "\"><input type=\"submit\" value=\"&#x1F5FA;&#xFE0F; Make new map\" onclick=\"return confirmcreate('" +
    world.name + "','" + world.worldname + "'," + world.hasmap.toString() + ');">\n' + htmlSelectDetail(world) + '\n</form>\n'
}

/**
 * map detail selection button - called by htmlButtonNewMap()
 * @param {*} world
 * @returns {string}
 */
function htmlSelectDetail (world) {
  let sel0 = ''; let sel1 = ''; let sel2 = ''
  const sel = ' selected'
  switch (world.mapdetail) {
    case '--html':
      sel0 = sel
      break
    case '--html-most':
      sel1 = sel
      break
    default:
      sel2 = sel
  }
  return ' showing: <select name="mapdetail">\
<option value="--html"' + sel0 + '>Overviews only</option>\
<option value="--html-most"' + sel1 + '>Overviews+Biomes</option>\
<option value="--html-all"' + sel2 + '>ALL details</option></select>'
}

/**
 * map privacy toggle - called by htmlMakeRow()
 * @param {*} world
 * @returns {string}
 */
function htmlButtonPublicToggle (world) {
  const newToggleValue = !world.publicmap
  return ' &nbsp; <form class="mapaction" method="post" action="/"><div class="' + (world.publicmap ? 'public' : 'private') + '"><input type="hidden" name="mapname" value="' +
    world.name + '"><input type="hidden" name="op" value="html_buttonPublicToggle"><input type="hidden" id="p' + world.name + '" name="scrollpos" value="0"><input type="hidden" name="publicmap" value="' +
    newToggleValue.toString() + '"> &nbsp;Map is ' + (world.publicmap ? '<strong>public</strong> ' : '<strong>private</strong> ') +
    '<input type="submit" value="' + (world.publicmap ? '&#x1F512;&#xFE0F; Make private' : '&#x1F513;&#xFE0F; Make public') +
    "\" onclick=\"return setscrollpos('p" + world.name + "');\">\n</div></form>\n"
}

/**
 * generate the bottom of the main HTML page - this also includes a scroll directive to scroll the page to the last position before it got regenerated
 * @param {number} scrollPosition
 * @returns {string}
 */
function htmlPageBottom (scrollPosition = 0) {
  return '\n</div>\n<div id="spinner" class="modal"><div class="modal-content"><img src="https://static.wikia.nocookie.net/minecraft_gamepedia/images/c/c0/End_Crystal_%28Slateless%29.gif" width="150" height="160" alt="[please wait]"><br>See console</div></div>\n\
<script>\n window.scrollTo(0,' + scrollPosition + ");\n</script>\n\
<div id=\"footer\"><hr><p>GUI front end for <a href=\"https://github.com/bedrock-viz/bedrock-viz\" target=\"_blank\">bedrock-viz</a> <cite>Minecraft</cite> map viewer.</p><p>Front end by <a href=\"https://www.nablu.com/p/about.html\" target=\"_blank\">Alex Matulich</a>.</p><p> Title and 'busy' graphic assets obtained from the <a href=\"\" target=\"_blank\">Minecraft Wiki</a>.</p></div>\n</body>\n</html>\n"
}

/**
 * Given a world directory name, find its index in the worlds[] list, return -1 if not found.
 * @param {string} dir
 * @returns {number}
 */
function findWorldIndex (dir) {
  let i = 0
  const len = worlds.length
  while (i < len && dir !== worlds[i].name) ++i
  return i >= len ? -1 : i
}

/**
 * Build the list of worlds and maps.
 * If isManagementUser=true, a complete list of all worlds on the computer is generated, with buttons to delete a map (if it exists) or generate a new map.
 * If isManagementUser=false, only worlds with maps are shown, with no options to delete or generate maps.
 * The excludeMap parameter specifies a map directory name to exclude when building the list, in case a deletion operation is still ongoing when this function is called.
 * @param {boolean} isManagementUser
 * @param {string} excludeMap
 * @param {number} scrollPosition
 * @returns {string}
 */
function makeMapList (isManagementUser, excludeMap = '', scrollPosition = 0) {
  let i; let k; let rows = 0; let mapsFound = 0; let img; let stats; let istats; let wrld; let newUnmappable = false; let removeindex = -1; let includemap
  let fpath; let ipath; let mapinfopath; let rawmapinfo; let mapinfo; let infotitle; let infodetail = '--html-all'; let publicmap = true

  console.log('Making html map list')
  let html = htmlPageTop(isManagementUser)

  // part 1 - scan mapsPath for maps and update corresponding worlds[] objects with whatever is found, and also find maps for  worlds that were deleted from Minecraft
  const files = fs.readdirSync(mapsPath)
  if (files.length > 0) {
    for (i = 0; i < files.length; i++) {
      fpath = mapsPath + '/' + files[i]
      try {
        stats = fs.statSync(fpath)
      } catch (err) {
        console.log(`Error getting ${fpath}`)
        continue
      }
      if (!stats.isDirectory()) continue
      ipath = fpath + '/index.html'
      try {
        istats = fs.statSync(ipath)
      } catch (err) {
        console.log(`Error getting ${ipath}`)
        continue
      }
      mapinfopath = fpath + '/mapinfo.json'
      mapinfo = ''
      if (fs.existsSync(mapinfopath)) {
        rawmapinfo = fs.readFileSync(mapinfopath)
        mapinfo = JSON.parse(rawmapinfo)
        infotitle = mapinfo.worldname !== undefined ? mapinfo.worldname : 'Unknown - not in Minecraft worlds'
        infodetail = mapinfo.mapdetail !== undefined ? mapinfo.mapdetail : '--html-all'
        publicmap = mapinfo.publicmap !== undefined ? mapinfo.publicmap : true
      } else {
        infodetail = '--html-all'
        publicmap = true
      }
      k = findWorldIndex(files[i])
      includemap = (files[i] !== excludeMap)
      if (k < 0) { // if map doesn't exist in Minecraft worlds, add it to the worlds[] list
        worlds[worlds.length] = {
          name: files[i],
          worldname: infotitle,
          mtimeMs: istats.mtimeMs,
          mtime: 'Unknown',
          hasmap: includemap,
          mappable: false,
          mapdetail: infodetail,
          publicmap
        }
        newUnmappable = true
      } else { // if the map corresponds to a world, just update the worlds[] data with the mapinfo.json contents
        worlds[k].hasmap = includemap
        worlds[k].mapdetail = infodetail
        if (worlds[k].hasmap) worlds[k].publicmap = publicmap
      }
      if (includemap) ++mapsFound
    }
    console.log(`Found ${mapsFound} maps`)
    if (newUnmappable) {
      // re-sort the worlds list if a map was inserted into the list for a deleted world
      worlds.sort((a, b) => {
        return b.mtimeMs - a.mtimeMs
      })
    }

    // part 2 - loop through all the worlds[] and build the body of the main page
    for (i = 0; i < worlds.length; i++) {
      wrld = worlds[i]
      if (wrld.name === excludeMap && !wrld.hasmap && !wrld.mappable) { // if map was deleted (or is being deleted) and has no world, then get ready to remove it
        removeindex = i
        continue
      }
      img = wrld.mappable
        ? '<img src="/thumbnails/' + wrld.name + '.jpg" style="width:320px;" alt="[thumbnail]" />'
        : '<img src="https://upload.wikimedia.org/wikipedia/commons/e/e1/No_sign2.svg" style="width:180px;" alt="[no thumbnail]" />'
      if ((wrld.hasmap && wrld.publicmap) || isManagementUser) { html += htmlMakeRow(isManagementUser, wrld, img, wrld.hasmap ? istats.mtime : 0) } // make new row in HTML page
      ++rows
    }
    if (removeindex > -1) worlds.splice(removeindex, 1) // remove map from list if deleted and has no world
  }
  if (rows === 0) html += '<p>No maps here yet!</p>'
  return html + htmlPageBottom(scrollPosition)
}

/**
 * asynchronous deletion of a map folder and its contents
 * @param {string} mapName
 */
function deleteMap (mapName) {
  const dir = mapsPath + '/' + mapName
  fs.rmSync(dir, { recursive: true })
  console.log(`DELETED ${dir}`)
}

/**
 * Write mapinfo.json file into map directory. An entire worlds object may be passed but all this needs is name, worldname, mapdetail, and publicmap in the object
 * @param {*} world
 */
function writeMetafile (world) {
  const mpath = mapsPath + '/' + world.name + '/mapinfo.json'
  console.log(`writing ${mpath}`)
  try {
    fs.writeFileSync(mpath, JSON.stringify({
      worldname: world.worldname,
      mapdetail: world.mapdetail,
      publicmap: world.publicmap
    }))
  } catch (err) {
    console.log(err)
  }
}

/**
 * @param request
 * @returns {{}}
 */
function parseCookies (request) {
  const list = {}
  const cookieHeader = request.headers?.cookie
  if (!cookieHeader) return list

  cookieHeader.split(';').forEach(function (cookie) {
    let [name, ...rest] = cookie.split('=')
    name = name?.trim()
    if (!name) return
    const value = rest.join('=').trim()
    if (!value) return
    list[name] = decodeURIComponent(value)
  })

  return list
}
