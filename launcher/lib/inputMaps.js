/**
 * Input mapping: one binding model for the UI, translated into each emulator's own format.
 *
 * Bindings captured in the UI:
 *   { t: 'key',  code: 'KeyX' }       KeyboardEvent.code
 *   { t: 'btn',  i: 0 }               W3C "standard" gamepad button index
 *   { t: 'axis', i: 1, d: -1 }        standard gamepad axis + direction (Y axes: -1 = up)
 *
 * Outputs:
 *   - RetroArch (N64, Mupen64Plus-Next with "alt-map" so every N64 button has its own RetroPad slot):
 *       keyboard  -> input_player1_* lines appended to the RetroArch config
 *       gamepad   -> a core remap (.rmp): physical RetroPad button -> N64 function
 *   - Dolphin (GameCube) -> [GCPad1] section of GCPadNew.ini
 *
 * Works in Node (module.exports) and in the renderer (window.InputMaps).
 */
(function (root) {
  'use strict';

  const CONTROLS = {
    n64: [
      { id: 'a', label: 'A', group: 'Buttons' },
      { id: 'b', label: 'B', group: 'Buttons' },
      { id: 'z', label: 'Z trigger', group: 'Buttons' },
      { id: 'start', label: 'Start', group: 'Buttons' },
      { id: 'l', label: 'L', group: 'Buttons' },
      { id: 'r', label: 'R', group: 'Buttons' },
      { id: 'cu', label: 'C-Up', group: 'C buttons' },
      { id: 'cd', label: 'C-Down', group: 'C buttons' },
      { id: 'cl', label: 'C-Left', group: 'C buttons' },
      { id: 'cr', label: 'C-Right', group: 'C buttons' },
      { id: 'su', label: 'Stick up', group: 'Analog stick', stick: true },
      { id: 'sd', label: 'Stick down', group: 'Analog stick', stick: true },
      { id: 'sl', label: 'Stick left', group: 'Analog stick', stick: true },
      { id: 'sr', label: 'Stick right', group: 'Analog stick', stick: true },
      { id: 'du', label: 'D-Up', group: 'D-pad' },
      { id: 'dd', label: 'D-Down', group: 'D-pad' },
      { id: 'dl', label: 'D-Left', group: 'D-pad' },
      { id: 'dr', label: 'D-Right', group: 'D-pad' },
    ],
    gc: [
      { id: 'a', label: 'A', group: 'Buttons' },
      { id: 'b', label: 'B', group: 'Buttons' },
      { id: 'x', label: 'X', group: 'Buttons' },
      { id: 'y', label: 'Y', group: 'Buttons' },
      { id: 'z', label: 'Z', group: 'Buttons' },
      { id: 'start', label: 'Start', group: 'Buttons' },
      { id: 'l', label: 'L trigger', group: 'Triggers' },
      { id: 'r', label: 'R trigger', group: 'Triggers' },
      { id: 'su', label: 'Stick up', group: 'Main stick' },
      { id: 'sd', label: 'Stick down', group: 'Main stick' },
      { id: 'sl', label: 'Stick left', group: 'Main stick' },
      { id: 'sr', label: 'Stick right', group: 'Main stick' },
      { id: 'mod', label: 'Walk modifier', group: 'Main stick', optional: true },
      { id: 'cu', label: 'C-Up', group: 'C-stick' },
      { id: 'cd', label: 'C-Down', group: 'C-stick' },
      { id: 'cl', label: 'C-Left', group: 'C-stick' },
      { id: 'cr', label: 'C-Right', group: 'C-stick' },
      { id: 'du', label: 'D-Up', group: 'D-pad' },
      { id: 'dd', label: 'D-Down', group: 'D-pad' },
      { id: 'dl', label: 'D-Left', group: 'D-pad' },
      { id: 'dr', label: 'D-Right', group: 'D-pad' },
    ],
  };

  const k = (code) => ({ t: 'key', code });
  const b = (i) => ({ t: 'btn', i });
  const ax = (i, d) => ({ t: 'axis', i, d });

  const DEFAULTS = {
    n64: {
      keyboard: {
        a: k('KeyK'), b: k('KeyJ'), z: k('Space'), start: k('Enter'), l: k('KeyQ'), r: k('KeyE'),
        cu: k('ArrowUp'), cd: k('ArrowDown'), cl: k('ArrowLeft'), cr: k('ArrowRight'),
        su: k('KeyW'), sd: k('KeyS'), sl: k('KeyA'), sr: k('KeyD'),
        du: k('KeyT'), dd: k('KeyG'), dl: k('KeyF'), dr: k('KeyH'),
      },
      gamepad: {
        a: b(0), b: b(2), z: b(6), start: b(9), l: b(4), r: b(5),
        cu: ax(3, -1), cd: ax(3, 1), cl: ax(2, -1), cr: ax(2, 1),
        su: ax(1, -1), sd: ax(1, 1), sl: ax(0, -1), sr: ax(0, 1),
        du: b(12), dd: b(13), dl: b(14), dr: b(15),
      },
    },
    gc: {
      keyboard: {
        a: k('KeyK'), b: k('KeyJ'), x: k('KeyL'), y: k('KeyI'), z: k('KeyU'), start: k('Enter'),
        l: k('KeyQ'), r: k('KeyE'),
        su: k('KeyW'), sd: k('KeyS'), sl: k('KeyA'), sr: k('KeyD'), mod: k('ShiftLeft'),
        cu: k('ArrowUp'), cd: k('ArrowDown'), cl: k('ArrowLeft'), cr: k('ArrowRight'),
        du: k('KeyT'), dd: k('KeyG'), dl: k('KeyF'), dr: k('KeyH'),
      },
      gamepad: {
        a: b(0), b: b(2), x: b(1), y: b(3), z: b(5), start: b(9), l: b(6), r: b(7),
        su: ax(1, -1), sd: ax(1, 1), sl: ax(0, -1), sr: ax(0, 1), mod: null,
        cu: ax(3, -1), cd: ax(3, 1), cl: ax(2, -1), cr: ax(2, 1),
        du: b(12), dd: b(13), dl: b(14), dr: b(15),
      },
    },
  };

  const STD_BUTTON_NAMES = [
    'A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2',
    'Back / Select', 'Start / Options', 'Left stick click', 'Right stick click',
    'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Guide / Home',
  ];
  const STD_AXIS_NAMES = ['Left stick X', 'Left stick Y', 'Right stick X', 'Right stick Y'];

  function prettyKey(code) {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    const map = {
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter',
      ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
      AltLeft: 'L-Alt', AltRight: 'R-Alt', Backspace: 'Backspace', Tab: 'Tab', Semicolon: ';', Quote: "'",
      Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']',
      Minus: '-', Equal: '=', Backquote: '`', CapsLock: 'Caps', MetaLeft: 'Cmd', MetaRight: 'R-Cmd',
    };
    return map[code] || code;
  }

  function describeBinding(bd) {
    if (!bd) return 'Unbound';
    if (bd.t === 'key') return prettyKey(bd.code);
    if (bd.t === 'btn') return STD_BUTTON_NAMES[bd.i] || `Button ${bd.i}`;
    if (bd.t === 'axis') {
      const name = STD_AXIS_NAMES[bd.i] || `Axis ${bd.i}`;
      const vertical = bd.i % 2 === 1;
      const dir = vertical ? (bd.d < 0 ? 'up' : 'down') : (bd.d < 0 ? 'left' : 'right');
      return name.replace(/ [XY]$/, '') + ' ' + dir;
    }
    return '?';
  }

  function sameBinding(a, c) {
    if (!a || !c || a.t !== c.t) return false;
    if (a.t === 'key') return a.code === c.code;
    if (a.t === 'btn') return a.i === c.i;
    return a.i === c.i && a.d === c.d;
  }

  /** Merge stored user bindings over defaults so newly added controls always have a value. */
  function resolve(system, mode, stored) {
    const base = DEFAULTS[system][mode];
    const out = {};
    for (const c of CONTROLS[system]) {
      const v = stored && Object.prototype.hasOwnProperty.call(stored, c.id) ? stored[c.id] : base[c.id];
      out[c.id] = v === undefined ? null : v;
    }
    return out;
  }

  /** Returns [{id, other}] pairs where two controls share one input. */
  function conflicts(system, map) {
    const ids = CONTROLS[system].map((c) => c.id);
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (sameBinding(map[ids[i]], map[ids[j]])) out.push({ id: ids[i], other: ids[j] });
      }
    }
    return out;
  }

  /** Rules a binding must follow for a given system/mode. Returns an error string or null. */
  function validate(system, mode, controlId, bd) {
    if (!bd) return null;
    if (mode === 'keyboard' && bd.t !== 'key') return 'Keyboard profile: press a key.';
    if (mode === 'gamepad' && bd.t === 'key') return 'Controller profile: press a controller button or move a stick.';
    if (system === 'n64' && mode === 'gamepad') {
      const ctl = CONTROLS.n64.find((c) => c.id === controlId);
      if (ctl && ctl.stick && !(bd.t === 'axis' && bd.i <= 1)) return 'The N64 analog stick must stay on the left stick.';
      if (ctl && !ctl.stick && bd.t === 'axis' && bd.i <= 1) return 'The left stick is reserved for the N64 analog stick.';
      if (ctl && !ctl.stick && !controlId.startsWith('c') && bd.t === 'axis') return 'Only C buttons can use the right stick.';
    }
    return null;
  }

  // ------------------------------------------------------------ RetroArch / N64
  // Mupen64Plus-Next with mupen64plus-alt-map=True: N64 function -> RetroPad id it reads
  const RETROPAD_IDS = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11, l2: 12, r2: 13, l3: 14, r3: 15 };
  const RETROPAD_NAMES = Object.keys(RETROPAD_IDS);
  const N64_TO_RETROPAD = {
    a: 'b', b: 'y', z: 'l2', start: 'start', l: 'select', r: 'r2',
    cu: 'x', cd: 'a', cl: 'l', cr: 'r',
    du: 'up', dd: 'down', dl: 'left', dr: 'right',
  };
  const N64_STICK_TO_RETRO_KEY = { su: 'l_y_minus', sd: 'l_y_plus', sl: 'l_x_minus', sr: 'l_x_plus' };
  // W3C standard gamepad button index -> RetroPad id (RetroArch autoconfig puts physical buttons here)
  const STD_TO_RETROPAD = [0, 8, 1, 9, 10, 11, 12, 13, 2, 3, 14, 15, 4, 5, 6, 7];

  const RA_KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', NumpadEnter: 'kp_enter',
    Tab: 'tab', Insert: 'insert', Delete: 'del', End: 'end', Home: 'home', ShiftRight: 'rshift', ShiftLeft: 'shift',
    ControlLeft: 'ctrl', ControlRight: 'rctrl', AltLeft: 'alt', AltRight: 'ralt', Space: 'space', Escape: 'escape',
    PageUp: 'pageup', PageDown: 'pagedown', Period: 'period', CapsLock: 'capslock', Backspace: 'backspace',
    Backquote: 'backquote', Quote: 'quote', Comma: 'comma', Minus: 'minus', Slash: 'slash', Semicolon: 'semicolon',
    Equal: 'equals', BracketLeft: 'leftbracket', BracketRight: 'rightbracket', Backslash: 'backslash',
    NumpadAdd: 'add', NumpadSubtract: 'subtract', NumpadMultiply: 'multiply', NumpadDivide: 'divide',
    NumpadDecimal: 'kp_period', MetaLeft: 'lsuper', MetaRight: 'rsuper',
  };

  function retroarchKey(code) {
    if (!code) return 'nul';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return 'num' + code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return 'keypad' + code.slice(6);
    if (/^F([1-9]|1[0-5])$/.test(code)) return code.toLowerCase();
    return RA_KEYS[code] || 'nul';
  }

  /** Keys RetroArch reserves while Netcade's hotkey modifier is NOT held are none; we gate all hotkeys. */
  function retroarchKeyboardConfig(map) {
    const cfg = {};
    for (const name of RETROPAD_NAMES) cfg[`input_player1_${name}`] = 'nul';
    for (const [fn, pad] of Object.entries(N64_TO_RETROPAD)) {
      const bd = map[fn];
      cfg[`input_player1_${pad}`] = bd && bd.t === 'key' ? retroarchKey(bd.code) : 'nul';
    }
    for (const [fn, key] of Object.entries(N64_STICK_TO_RETRO_KEY)) {
      const bd = map[fn];
      cfg[`input_player1_${key}`] = bd && bd.t === 'key' ? retroarchKey(bd.code) : 'nul';
    }
    for (const key of ['r_x_plus', 'r_x_minus', 'r_y_plus', 'r_y_minus']) cfg[`input_player1_${key}`] = 'nul';
    return cfg;
  }

  /**
   * Core remap file for controller play. Physical RetroPad button j (where RetroArch's autoconfig
   * put the button the user pressed) -> RetroPad id that Mupen64Plus-Next reads for the N64 function.
   */
  function retroarchRemap(map) {
    const physToTarget = new Array(16).fill(-1);
    const warnings = [];
    for (const [fn, pad] of Object.entries(N64_TO_RETROPAD)) {
      const bd = map[fn];
      if (!bd) continue;
      if (bd.t === 'btn' && bd.i < 16) {
        physToTarget[STD_TO_RETROPAD[bd.i]] = RETROPAD_IDS[pad];
      } else if (bd.t === 'axis' && fn.startsWith('c') && bd.i >= 2) {
        // right stick drives the C buttons natively in Mupen64Plus-Next; nothing to remap
      } else {
        warnings.push(`${fn}: unsupported binding ignored`);
      }
    }
    const lines = ['# Generated by Netcade. Edit your controls in Netcade, not here.'];
    for (let j = 0; j < 16; j++) lines.push(`input_player1_btn_${RETROPAD_NAMES.find((n) => RETROPAD_IDS[n] === j)} = "${physToTarget[j]}"`);
    // analog sticks stay identity: left = N64 stick, right = C buttons
    const stk = ['l_x+', 'l_x-', 'l_y+', 'l_y-', 'r_x+', 'r_x-', 'r_y+', 'r_y-'];
    stk.forEach((s, i) => lines.push(`input_player1_stk_${s} = "${16 + i}"`));
    return { text: lines.join('\n') + '\n', warnings };
  }

  /** An identity remap (used in keyboard mode so stale controller remaps don't apply). */
  function retroarchIdentityRemap() {
    const lines = ['# Generated by Netcade (keyboard profile active).'];
    for (let j = 0; j < 16; j++) lines.push(`input_player1_btn_${RETROPAD_NAMES.find((n) => RETROPAD_IDS[n] === j)} = "${j}"`);
    return lines.join('\n') + '\n';
  }

  // ------------------------------------------------------------ Dolphin / GC
  const DOLPHIN_KEYS = {
    win32: {
      ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'RETURN', Space: 'SPACE',
      ShiftLeft: 'LSHIFT', ShiftRight: 'RSHIFT', ControlLeft: 'LCONTROL', ControlRight: 'RCONTROL',
      AltLeft: 'LMENU', AltRight: 'RMENU', Tab: 'TAB', Backspace: 'BACK', Semicolon: 'SEMICOLON',
      Quote: 'APOSTROPHE', Comma: 'COMMA', Period: 'PERIOD', Slash: 'SLASH', BracketLeft: 'LBRACKET',
      BracketRight: 'RBRACKET', Backslash: 'BACKSLASH', Minus: 'MINUS', Equal: 'EQUALS', Backquote: 'GRAVE',
      NumpadEnter: 'NUMPADENTER', Home: 'HOME', End: 'END', PageUp: 'PRIOR', PageDown: 'NEXT', Insert: 'INSERT',
      Delete: 'DELETE', CapsLock: 'CAPITAL', NumpadAdd: 'ADD', NumpadSubtract: 'SUBTRACT',
      NumpadMultiply: 'MULTIPLY', NumpadDivide: 'DIVIDE', NumpadDecimal: 'DECIMAL', Escape: 'ESCAPE',
    },
    darwin: {
      ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow', ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow',
      Enter: 'Return', Space: 'Space', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
      ControlLeft: 'Left Control', ControlRight: 'Right Control', AltLeft: 'Left Alt', AltRight: 'Right Alt',
      Tab: 'Tab', Backspace: 'Backspace', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: 'Tilde', Comma: ',', Period: '.', Slash: '/',
      CapsLock: 'Caps Lock', NumpadEnter: 'Keypad Enter', Home: 'Home', End: 'End', PageUp: 'Page Up',
      PageDown: 'Page Down', Delete: 'Delete', MetaLeft: 'Command', Escape: 'Escape',
      NumpadAdd: 'Keypad +', NumpadSubtract: 'Keypad -', NumpadMultiply: 'Keypad *', NumpadDivide: 'Keypad /',
      NumpadDecimal: 'Keypad .',
    },
    linux: {
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Space: 'space',
      ShiftLeft: 'Shift_L', ShiftRight: 'Shift_R', ControlLeft: 'Control_L', ControlRight: 'Control_R',
      AltLeft: 'Alt_L', AltRight: 'Alt_R', Tab: 'Tab', Backspace: 'BackSpace', Minus: 'minus', Equal: 'equal',
      BracketLeft: 'bracketleft', BracketRight: 'bracketright', Backslash: 'backslash', Semicolon: 'semicolon',
      Quote: 'apostrophe', Backquote: 'grave', Comma: 'comma', Period: 'period', Slash: 'slash',
      CapsLock: 'Caps_Lock', NumpadEnter: 'KP_Enter', Home: 'Home', End: 'End', PageUp: 'Prior',
      PageDown: 'Next', Delete: 'Delete', Insert: 'Insert', Escape: 'Escape',
      Numpad0: 'KP_Insert', Numpad1: 'KP_End', Numpad2: 'KP_Down', Numpad3: 'KP_Next', Numpad4: 'KP_Left',
      Numpad5: 'KP_Begin', Numpad6: 'KP_Right', Numpad7: 'KP_Home', Numpad8: 'KP_Up', Numpad9: 'KP_Prior',
    },
  };

  const DOLPHIN_KEYBOARD_DEVICE = {
    win32: 'DInput/0/Keyboard Mouse',
    darwin: 'Quartz/0/Keyboard & Mouse',
    linux: 'XInput2/0/Virtual core pointer',
  };

  function dolphinKey(code, platform) {
    if (!code) return '';
    const table = DOLPHIN_KEYS[platform] || DOLPHIN_KEYS.linux;
    if (table[code]) return table[code];
    if (/^Key[A-Z]$/.test(code)) return platform === 'linux' ? code.slice(3).toLowerCase() : code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    if (/^Numpad[0-9]$/.test(code)) {
      const n = code.slice(6);
      return platform === 'win32' ? 'NUMPAD' + n : platform === 'darwin' ? 'Keypad ' + n : '';
    }
    return '';
  }

  const DOLPHIN_STD_BUTTONS = [
    'Button A', 'Button B', 'Button X', 'Button Y', 'Shoulder L', 'Shoulder R', 'Trigger L', 'Trigger R',
    'Back', 'Start', 'Thumb L', 'Thumb R', 'Pad N', 'Pad S', 'Pad W', 'Pad E', 'Guide',
  ];
  const DOLPHIN_AXES = ['Left X', 'Left Y', 'Right X', 'Right Y'];

  function dolphinPadExpr(bd) {
    if (!bd) return '';
    if (bd.t === 'btn') return DOLPHIN_STD_BUTTONS[bd.i] ? '`' + DOLPHIN_STD_BUTTONS[bd.i] + '`' : '';
    if (bd.t === 'axis') {
      const name = DOLPHIN_AXES[bd.i];
      if (!name) return '';
      // Dolphin follows XInput: Y+ is up. The Gamepad API uses -1 for up.
      const vertical = bd.i % 2 === 1;
      const sign = vertical ? (bd.d < 0 ? '+' : '-') : (bd.d < 0 ? '-' : '+');
      return '`' + name + sign + '`';
    }
    return '';
  }

  /**
   * Build the [GCPad1] section for Dolphin's GCPadNew.ini.
   * device: { kind: 'keyboard' } | { kind: 'xinput', index } | { kind: 'sdl', index, name }
   */
  function dolphinGCPad(map, device, platform) {
    let deviceStr;
    let expr;
    if (device.kind === 'keyboard') {
      deviceStr = DOLPHIN_KEYBOARD_DEVICE[platform] || DOLPHIN_KEYBOARD_DEVICE.linux;
      expr = (bd) => {
        const n = bd && bd.t === 'key' ? dolphinKey(bd.code, platform) : '';
        return n ? '`' + n + '`' : '';
      };
    } else {
      deviceStr = device.kind === 'xinput'
        ? `XInput/${device.index | 0}/Gamepad`
        : `SDL/${device.index | 0}/${device.name || 'Controller'}`;
      expr = dolphinPadExpr;
    }
    const L = [];
    const set = (key, val) => L.push(`${key} = ${val}`);
    set('Device', deviceStr);
    set('Buttons/A', expr(map.a));
    set('Buttons/B', expr(map.b));
    set('Buttons/X', expr(map.x));
    set('Buttons/Y', expr(map.y));
    set('Buttons/Z', expr(map.z));
    set('Buttons/Start', expr(map.start));
    set('Main Stick/Up', expr(map.su));
    set('Main Stick/Down', expr(map.sd));
    set('Main Stick/Left', expr(map.sl));
    set('Main Stick/Right', expr(map.sr));
    set('Main Stick/Modifier', expr(map.mod));
    set('Main Stick/Modifier/Range', '50.0');
    set('C-Stick/Up', expr(map.cu));
    set('C-Stick/Down', expr(map.cd));
    set('C-Stick/Left', expr(map.cl));
    set('C-Stick/Right', expr(map.cr));
    set('C-Stick/Modifier/Range', '50.0');
    set('Triggers/L', expr(map.l));
    set('Triggers/R', expr(map.r));
    const analogTrigger = (bd) => (device.kind !== 'keyboard' && bd && bd.t === 'btn' && (bd.i === 6 || bd.i === 7) ? expr(bd) : '');
    set('Triggers/L-Analog', analogTrigger(map.l));
    set('Triggers/R-Analog', analogTrigger(map.r));
    set('D-Pad/Up', expr(map.du));
    set('D-Pad/Down', expr(map.dd));
    set('D-Pad/Left', expr(map.dl));
    set('D-Pad/Right', expr(map.dr));
    if (device.kind === 'xinput') set('Rumble/Motor', '`Motor L` | `Motor R`');
    return L.join('\n');
  }

  /** Guess Dolphin's SDL device name from the browser's gamepad id string. */
  function guessSdlName(gamepadId) {
    const id = String(gamepadId || '');
    const vp = /Vendor:\s*([0-9a-f]{4})\s*Product:\s*([0-9a-f]{4})/i.exec(id) || /([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id);
    const known = {
      '054c:0ce6': 'PS5 Controller', '054c:0df2': 'PS5 Controller', '054c:05c4': 'PS4 Controller',
      '054c:09cc': 'PS4 Controller', '057e:2009': 'Nintendo Switch Pro Controller',
      '054c:0268': 'PS3 Controller', '057e:0337': 'Nintendo GameCube Controller', '045e:028e': 'Xbox 360 Controller',
      '045e:02ea': 'Xbox One Controller', '045e:0b12': 'Xbox Series X Controller', '045e:0b13': 'Xbox Series X Controller',
    };
    if (vp) {
      const hit = known[`${vp[1].toLowerCase()}:${vp[2].toLowerCase()}`];
      if (hit) return hit;
    }
    return id.replace(/\s*\(.*$/, '').trim() || 'Controller';
  }

  function isXInputLike(gamepadId) {
    return /xinput|xbox|045e/i.test(String(gamepadId || ''));
  }

  const api = {
    CONTROLS, DEFAULTS, STD_BUTTON_NAMES, STD_AXIS_NAMES,
    resolve, conflicts, validate, describeBinding, prettyKey, sameBinding,
    retroarchKey, retroarchKeyboardConfig, retroarchRemap, retroarchIdentityRemap,
    dolphinKey, dolphinGCPad, dolphinPadExpr, guessSdlName, isXInputLike,
    N64_TO_RETROPAD, STD_TO_RETROPAD,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InputMaps = api;
})(typeof window !== 'undefined' ? window : globalThis);
