// This is main process of Electron, started as first thing when your
// app starts. It runs through entire life of your application.
// It doesn't have any windows which you can see on screen, but we can open
// window from here.

import path from "path";
import url from "url";
import os from 'os';
import { app, Menu, ipcMain, Tray, dialog } from "electron";
import createWindow from "./helpers/window";
import { autoUpdater } from 'electron-updater'
import appPath from './electronAppPath'

import { devMenuTemplate } from "./menu/dev_menu_template";
import { editMenuTemplate } from "./menu/edit_menu_template";
import { settingsMenuTemplate } from "./menu/config_menu_template";
import { aboutMenuTemplate } from "./menu/about_menu_template";
import { manageMenuTemplate } from "./menu/manage_menu_template";

// Special module holding environment variables which you declared
// in config/env_xxx.json file.
import env from "env";

const { spawn, exec } = require('child_process')
const fs = require('fs')
const iconv = require('iconv-lite');

// plugins and dev tool
require('electron-context-menu')({})

const setApplicationMenu = () => {
  const menus = [editMenuTemplate, manageMenuTemplate, settingsMenuTemplate, aboutMenuTemplate];
  if (env.name !== "production") {
    menus.push(devMenuTemplate);
  }
  // append version as disabled menu item
  menus.push({
    label: app.getVersion()
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus));
};

// Save userData in separate folders for each environment.
// Thanks to this you can use production and development versions of the app
// on same machine like those are two separate apps.
if (env.name !== "production") {
  const userDataPath = app.getPath("userData");
  app.setPath("userData", `${userDataPath} (${env.name})`);
}
// portative version
let portative = false
if(env.name === "production") {
  if(fs.existsSync(path.dirname(process.execPath) + `/data`))
  {
    portative = true;
    app.setPath("userData", path.dirname(process.execPath) + `/data`);
  }
}

const resourcesPath = env.name === "production" ? process.resourcesPath : 'resources'

const spiderCall = require('./spider')
const appConfig = require('./config')

let mainWindow = undefined
let sphinx = undefined
let spider = undefined

const util = require('util');
if (!fs.existsSync(app.getPath("userData"))){
  fs.mkdirSync(app.getPath("userData"));
}
const logFile = fs.createWriteStream(app.getPath("userData") + '/rats.log', {flags : 'w'});
const logStdout = process.stdout;

console.log = (...d) => {
  const date = (new Date).toLocaleTimeString()
  logFile.write(`[${date}] ` + util.format(...d) + '\n');
  logStdout.write(util.format(...d) + '\n');
};

// print os info
console.log('Rats', app.getVersion())
console.log('Platform:', os.platform())
console.log('Arch:', os.arch())
console.log('OS Release:', os.release())
console.log('CPU:', os.cpus()[0].model)
console.log('CPU Logic cores:', os.cpus().length)
console.log('Total memory:', (os.totalmem() / (1024 * 1024)).toFixed(2), 'MB')
console.log('Free memory:', (os.freemem() / (1024 * 1024)).toFixed(2), 'MB')

if(portative)
console.log('portative compability')

const shouldQuit = app.makeSingleInstance(function(commandLine, workingDirectory) {
  // Someone tried to run a second instance, we should focus our window.
  console.log('openned second application, just focus this one')
  if (mainWindow) {
    if (mainWindow.isMinimized()) 
      mainWindow.restore();
    mainWindow.focus();
  }
});

if (shouldQuit) {
  console.log('closed because of second application')
  app.exit(0);
}

const writeSphinxConfig = (path, dbPath) => {
  let config = `
  index torrents
  {
    type = rt
    path = ${dbPath}/database/torrents
    
    rt_attr_string = hash
    rt_attr_string = name
    rt_field = nameIndex
    rt_attr_bigint = size
    rt_attr_uint = files
    rt_attr_uint = piecelength
    rt_attr_timestamp = added
    rt_attr_string = ipv4
    rt_attr_uint = port
    rt_attr_string = contentType
    rt_attr_string = contentCategory
    rt_attr_uint = seeders
    rt_attr_uint = leechers
    rt_attr_uint = completed
    rt_attr_timestamp = trackersChecked
    rt_attr_uint = good
    rt_attr_uint = bad
  }

  index files
  {
      type = rt
      path = ${dbPath}/database/files
      
      rt_attr_string = path
      rt_field = pathIndex
    rt_attr_string = hash
    rt_attr_bigint = size
  }

  index statistic
  {
      type = rt
      path = ${dbPath}/database/statistic
      
    rt_attr_bigint = size
    rt_attr_bigint = files
    rt_attr_uint = torrents
  }

  searchd
  {
    listen      = 9312
    listen      = 9306:mysql41
    read_timeout    = 5
    max_children    = 30
    seamless_rotate   = 1
    preopen_indexes   = 1
    unlink_old    = 1
    workers     = threads # for RT to work
    pid_file    = ${path}/searchd.pid
    log     = ${path}/searchd.log
    query_log   = ${path}/query.log
    binlog_path = ${path}
  }
  `;

  // clear dir in test env
  if(env.name === 'test')
  {
    if (fs.existsSync(`${dbPath}/database`)) {
      fs.readdirSync(`${dbPath}/database`).forEach(function(file, index){
        const curPath = `${dbPath}/database` + "/" + file;
        if (!fs.lstatSync(curPath).isDirectory()) {
          fs.unlinkSync(curPath);
        }
      });

      fs.readdirSync(path).forEach(function(file, index){
        if(!file.startsWith('binlog'))
          return;
        const curPath = path + "/" + file;
        if (!fs.lstatSync(curPath).isDirectory()) {
          fs.unlinkSync(curPath);
        }
      });
    }
  }

  if (!fs.existsSync(`${dbPath}/database`)){
    fs.mkdirSync(`${dbPath}/database`);
  }

  if(/^win/.test(process.platform))
    config = iconv.encode(config, 'win1251')

  fs.writeFileSync(`${path}/sphinx.conf`, config)
  console.log(`writed sphinx config to ${path}`)
  console.log('db path:', dbPath)
}

const sphinxPath = path.resolve(appPath('searchd'))
console.log('Sphinx Path:', sphinxPath)

const startSphinx = (callback) => {
  const sphinxConfigDirectory = app.getPath("userData")
  appConfig['dbPath'] = appConfig.dbPath && appConfig.dbPath.length > 0 ? appConfig.dbPath : sphinxConfigDirectory;
  // on portable dir can move database directory
  if(!fs.existsSync(appConfig.dbPath) && fs.existsSync(sphinxConfigDirectory))
  {
    appConfig['dbPath'] = sphinxConfigDirectory
  }

  writeSphinxConfig(sphinxConfigDirectory, appConfig.dbPath)

  const config = `${sphinxConfigDirectory}/sphinx.conf`
  const options = ['--config', config]
  if(!(/^win/.test(process.platform)))
  {
  	options.push('--nodetach')
  }
  sphinx = spawn(sphinxPath, options)

  sphinx.stdout.on('data', (data) => {
    console.log(`sphinx: ${data}`)
    if (data.includes('accepting connections')) {
      console.log('catched sphinx start')
      if(callback)
        callback()
    }
  })

  sphinx.on('close', (code, signal) => {
    console.log(`sphinx closed with code ${code} and signal ${signal}`)
    app.quit()
  })

  sphinx.stop = () => {
    console.log('sphinx closing...')
  	exec(`"${sphinxPath}" --config "${config}" --stopwait`)
  }
}

// log autoupdate
const log = require('electron-log')
log.transports.file.level = false;
log.transports.console.level = false;
log.transports.console = function(msg) {
  const text = util.format.apply(util, msg.data);
  console.log(text);
};
autoUpdater.logger = log;

autoUpdater.on('update-downloaded', () => {
  console.log('update-downloaded lats quitAndInstall');
  if (env.name === "production") { 
    dialog.showMessageBox({
      type: 'info',
      title: 'Found Updates',
      message: 'Found updates, do you want update now?',
      buttons: ['Sure', 'No']
    }, (buttonIndex) => {
      if (buttonIndex === 0) {
        const isSilent = true;
        const isForceRunAfter = true; 
        autoUpdater.quitAndInstall(isSilent, isForceRunAfter); 
      }
    })
  }
})

let tray = undefined

app.on("ready", () => {
  startSphinx(() => {
    setApplicationMenu();

    mainWindow = createWindow("main", {
      width: 1000,
      height: 600
    });

    mainWindow.loadURL(
      url.format({
        pathname: path.join(__dirname, "app.html"),
        protocol: "file:",
        slashes: true
      })
    );

    if (env.name === "development") {
      mainWindow.openDevTools();
    }

    if(process.platform === 'darwin')
      tray = new Tray(`${resourcesPath}/icons/19x19.png`)
    else
      tray = new Tray(`${resourcesPath}/icons/512x512.png`)

    tray.on('click', () => {
	  mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
	})
	mainWindow.on('show', () => {
	  tray.setHighlightMode('always')
	})
	mainWindow.on('hide', () => {
	  tray.setHighlightMode('never')
  })
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })

	mainWindow.on('minimize', (event) => {
	    event.preventDefault();
	    mainWindow.hide();
	});

	var contextMenu = Menu.buildFromTemplate([
	    { label: 'Show', click:  function(){
	        mainWindow.show();
	    } },
	    { label: 'Quit', click:  function(){
	        app.isQuiting = true;
	        if (sphinx)
			    stop()
			else 
			    app.quit()
	    } }
	]);

	tray.setContextMenu(contextMenu)
	tray.setToolTip('Rats on The Boat search')

  mainWindow.webContents.on('will-navigate', e => { e.preventDefault() })
  mainWindow.webContents.on('new-window', (event, url, frameName) => {
    if(frameName == '_self')
    {
          event.preventDefault()
          mainWindow.loadURL(url)
    }
  })

  if (env.name === "production" && !portative) { autoUpdater.checkForUpdates() }

    spider = spiderCall((...data) => { 
      if(mainWindow)
        mainWindow.webContents.send(...data) 
    }, (message, callback) => {
      ipcMain.on(message, (event, arg) => {
         if(Array.isArray(arg) && typeof arg[arg.length - 1] === 'object' && arg[arg.length - 1].callback)
         {
            const id = arg[arg.length - 1].callback
            arg[arg.length - 1] = (responce) => {
                mainWindow.webContents.send('callback', id, responce)
            }
         }
         callback.apply(null, arg)
      })
    }, app.getPath("userData"), app.getVersion(), env.name)
  })
});

let stopProtect = false
const stop = () => {
  if(stopProtect)
    return
  stopProtect = true

  if(tray)
  	tray.destroy()

  if(spider)
  {
      spider.stop(() => sphinx.stop())
  }
  else
  {
      sphinx.stop()
  }
}

app.on("window-all-closed", () => {
  if (sphinx)
    stop()
  else 
    app.quit()
});

app.on('before-quit', () => {
  if (sphinx)
    stop()
})