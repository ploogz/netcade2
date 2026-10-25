'use strict';
/**
 * RetroArch + Mupen64Plus-Next integration (N64).
 *
 * RetroArch's netplay can be driven entirely from the command line (--host / --connect), so N64
 * matches start with one click. Netcade writes an "append config" that is layered on top of the
 * player's own retroarch.cfg for this launch only (config_save_on_exit is off), plus its own
 * core-options file and remap folder.
 */
const fs = require('fs');
const path = require('path');
const { resolve, retroarchKeyboardConfig, retroarchRemap, retroarchIdentityRemap } = require('./inputMaps');

const CORE_DIR_NAME = 'Mupen64Plus-Next';

function q(v) {
  return `"${String(v).replace(/"/g, '')}"`;
}

/**
 * Netplay-sensitive core options are decided by the host and sent to everyone in the launch
 * message, so all players emulate identically (different renderers can desync).
 */
function coreOptions(settings, hostOptions) {
  const g = settings.graphics || {};
  const renderer = hostOptions?.n64Renderer || g.n64Renderer || 'parallel';
  const scale = Math.max(1, Math.min(8, g.n64Scale || 2));
  const parallelScale = scale >= 8 ? '8x' : scale >= 4 ? '4x' : scale >= 2 ? '2x' : '1x';
  const res43 = { 1: '320x240', 2: '640x480', 3: '960x720', 4: '1280x960', 5: '1600x1200' }[Math.min(5, scale)] || '640x480';
  return {
    'mupen64plus-rdp-plugin': renderer,
    'mupen64plus-rsp-plugin': renderer === 'parallel' ? 'parallel' : 'hle',
    'mupen64plus-parallel-rdp-upscaling': parallelScale,
    'mupen64plus-43screensize': res43,
    'mupen64plus-aspect': g.widescreen && renderer === 'gliden64' ? '16:9 adjusted' : '4:3',
    'mupen64plus-cpucore': 'dynamic_recompiler',
    'mupen64plus-alt-map': 'True',          // every N64 button gets its own RetroPad slot (see inputMaps.js)
    'mupen64plus-pak1': 'memory',
    'mupen64plus-pak2': 'memory',
    'mupen64plus-pak3': 'memory',
    'mupen64plus-pak4': 'memory',
  };
}

/**
 * opts: { dataDir, mode: 'solo'|'host'|'guest', settings, nickname, inputDelay, hostOptions, bundle,
 *         port (1-4, the lobby's controller port), spectate (watch instead of play), cmdPort }
 *   bundle: { autoconfig } when using Netcade's built-in RetroArch. Then RetroArch runs on a
 *   config file Netcade owns, so nothing touches a RetroArch install the player may also have.
 * Returns { appendConfig, baseConfig }
 */
function prepare(opts) {
  const { dataDir, settings, mode } = opts;
  const g = settings.graphics || {};
  const dirs = {
    saves: path.join(dataDir, 'saves'),
    states: path.join(dataDir, 'states'),
    remaps: path.join(dataDir, 'remaps'),
    system: path.join(dataDir, 'system'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  const renderer = opts.hostOptions?.n64Renderer || g.n64Renderer || 'parallel';
  const optsFile = path.join(dataDir, 'netcade-core-options.opt');
  fs.writeFileSync(optsFile, Object.entries(coreOptions(settings, opts.hostOptions)).map(([k, v]) => `${k} = ${q(v)}`).join('\n') + '\n');

  // ----- controls
  const c = settings.controls?.n64 || {};
  const inputMode = c.mode === 'gamepad' ? 'gamepad' : 'keyboard';
  const remapDir = path.join(dirs.remaps, CORE_DIR_NAME);
  fs.mkdirSync(remapDir, { recursive: true });
  const cfg = {};
  if (inputMode === 'keyboard') {
    Object.assign(cfg, retroarchKeyboardConfig(resolve('n64', 'keyboard', c.keyboard)));
    fs.writeFileSync(path.join(remapDir, `${CORE_DIR_NAME}.rmp`), retroarchIdentityRemap());
  } else {
    const { text } = retroarchRemap(resolve('n64', 'gamepad', c.gamepad));
    fs.writeFileSync(path.join(remapDir, `${CORE_DIR_NAME}.rmp`), text);
  }

  Object.assign(cfg, {
    // keep the player's own retroarch.cfg untouched
    config_save_on_exit: 'false',
    // video
    video_driver: renderer === 'parallel' ? 'vulkan' : 'glcore',
    video_fullscreen: g.fullscreen ? 'true' : 'false',
    video_vsync: g.vsync === false ? 'false' : 'true',
    video_fps_show: g.showFps ? 'true' : 'false',
    // folders
    savefile_directory: dirs.saves,
    savestate_directory: dirs.states,
    input_remapping_directory: dirs.remaps,
    system_directory: dirs.system,
    core_options_path: optsFile,
    global_core_options: 'true',
    auto_remaps_enable: 'true',
    remap_save_on_exit: 'false',
    // input: all RetroArch hotkeys require holding Right Ctrl, so game keys never trigger them
    input_autodetect_enable: 'true',
    input_enable_hotkey: 'rctrl',
    input_enable_hotkey_btn: 'nul',
    input_exit_emulator: 'escape',
    input_toggle_fullscreen: 'f',
    input_menu_toggle: 'f1',
    input_menu_toggle_gamepad_combo: '0',
    input_hold_fast_forward: 'nul',
    input_toggle_fast_forward: 'nul',
    input_rewind: 'nul',
    // window / UX
    pause_nonactive: 'false',
    video_window_save_positions: 'false',
    menu_show_load_content_animation: 'false',
    notification_show_netplay_extra: 'true',
    savestate_auto_load: 'false',
    savestate_auto_save: 'false',
    // netplay
    netplay_nickname: (opts.nickname || 'Player').replace(/["\r\n]/g, ''),
    netplay_nat_traversal: 'true',
    netplay_public_announce: 'false',
    netplay_use_mitm_server: 'false',
    netplay_allow_pausing: 'false',
    netplay_allow_slaves: 'true',
    netplay_input_latency_frames_min: String(Math.max(0, Math.min(15, (opts.inputDelay | 0) || 0))),
    netplay_input_latency_frames_range: '2',
    netplay_check_frames: '600',
    // sit on exactly the lobby's controller port, or watch
    netplay_start_as_spectator: opts.spectate ? 'true' : 'false',
    ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`netplay_request_device_p${i + 1}`, !opts.spectate && opts.port === i + 1 ? 'true' : 'false'])),
    // borderless fullscreen so Netcade's in-game overlay can draw on top
    video_windowed_fullscreen: 'true',
    // local command channel (play/spectate switching for live port swaps)
    network_cmd_enable: opts.cmdPort ? 'true' : 'false',
    network_cmd_port: String(opts.cmdPort || 55355),
  });

  let baseConfig = null;
  if (opts.bundle) {
    Object.assign(cfg, {
      joypad_autoconfig_dir: opts.bundle.autoconfig || '',
      menu_driver: 'rgui',                 // the built-in copy ships without menu artwork
      rgui_show_start_screen: 'false',
      check_firmware_before_loading: 'false',
      log_dir: path.join(dataDir, 'logs'),
      cache_directory: path.join(dataDir, 'cache'),
      playlist_directory: path.join(dataDir, 'playlists'),
      content_history_path: path.join(dataDir, 'content_history.lpl'),
      video_shader_enable: 'false',
    });
    baseConfig = path.join(dataDir, 'retroarch.cfg');
    if (!fs.existsSync(baseConfig)) fs.writeFileSync(baseConfig, '# Netcade-managed RetroArch config\n');
  }

  const appendConfig = path.join(dataDir, `netcade-${mode}.cfg`);
  fs.writeFileSync(appendConfig, Object.entries(cfg).map(([k, v]) => `${k} = ${q(v)}`).join('\n') + '\n');
  return { appendConfig, baseConfig, inputMode, renderer, cmdPort: opts.cmdPort || 0 };
}

/**
 * Arguments for retroarch. net: { role: 'host'|'guest', ip, port }
 */
function args({ corePath, romPath, appendConfig, baseConfig, nickname, net }) {
  const a = ['-L', corePath];
  if (baseConfig) a.push('--config', baseConfig);
  a.push('--appendconfig', appendConfig);
  if (net?.role === 'host') a.push('--host', '--port', String(net.port));
  if (net?.role === 'guest') a.push('--connect', net.ip, '--port', String(net.port));
  if (net) a.push('--nick', (nickname || 'Player').slice(0, 32));
  a.push(romPath);
  return a;
}

/** Send a command to a running RetroArch (UDP, local only). */
function sendCommand(cmdPort, command) {
  return new Promise((resolve) => {
    const sock = require('dgram').createSocket('udp4');
    sock.send(Buffer.from(command), cmdPort, '127.0.0.1', (err) => {
      sock.close();
      resolve(!err);
    });
  });
}

module.exports = { prepare, args, coreOptions, sendCommand, CORE_DIR_NAME };
