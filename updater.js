'use strict';
// In-app updates from GitHub Releases, through electron-updater. Does nothing when run from
// source (npm start); it only works in the installed app.
//
// Quiet by default: it checks a little after start and every few hours, downloads a new version
// in the background, and asks before restarting. "Check for updates" in the tray menu always
// says what happened, even when there is nothing new.
const { app, dialog } = require('electron');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let autoUpdater = null;
let checking = false;
let asked = false; // the person pressed the menu item, so report the outcome
let promptedFor = '';

const say = (type, message, detail) => dialog.showMessageBox({ type, title: 'Clawd', message, detail });

function init({ enabled }) {
  if (!app.isPackaged) return false;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return false; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // pressing "Later" still updates the next time he quits

  autoUpdater.on('update-available', (info) => {
    if (asked) say('info', `Clawd ${info.version} is available.`, "I'm downloading it now and will ask before restarting.");
  });
  autoUpdater.on('update-not-available', () => {
    checking = false;
    if (asked) say('info', "You're up to date.", `Clawd ${app.getVersion()} is the latest version.`);
    asked = false;
  });
  autoUpdater.on('update-downloaded', (info) => {
    checking = false;
    asked = false;
    if (promptedFor === info.version) return;
    promptedFor = info.version;
    dialog.showMessageBox({
      type: 'info', title: 'Clawd', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `Clawd ${info.version} is ready.`,
      detail: 'Restart to finish updating. His memories and settings are kept. If you pick Later, it installs the next time he quits.',
    }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(true, true); });
  });
  autoUpdater.on('error', (err) => {
    checking = false;
    if (asked) say('error', "Couldn't check for updates.", String((err && err.message) || err).slice(0, 300));
    asked = false;
  });

  setTimeout(() => { if (enabled()) check(false); }, 20 * 1000);
  setInterval(() => { if (enabled()) check(false); }, CHECK_EVERY_MS).unref();
  return true;
}

function check(byRequest) {
  if (!autoUpdater) {
    if (byRequest) say('info', 'Updates work in the installed version.', 'You are running Clawd from source. Pull the latest code and run npm install.');
    return;
  }
  if (checking) {
    if (byRequest) say('info', 'Already checking for updates.');
    return;
  }
  checking = true;
  asked = byRequest;
  autoUpdater.checkForUpdates().catch(() => {}); // failures also arrive through the 'error' event
}

module.exports = { init, check };
