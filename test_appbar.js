const koffi = require('koffi');
const shell32 = koffi.load('shell32.dll');
const user32 = koffi.load('user32.dll');

const RECT = koffi.struct('RECT', {
  left: 'int', top: 'int', right: 'int', bottom: 'int'
});

const APPBARDATA = koffi.struct('APPBARDATA', {
  cbSize: 'uint32',
  hWnd: 'void*',
  uCallbackMessage: 'uint32',
  uEdge: 'uint32',
  rc: RECT,
  lParam: 'intptr_t'
});

const SHAppBarMessage = shell32.func('intptr_t SHAppBarMessage(uint32 dwMessage, APPBARDATA* pData)');
const FindWindowA = user32.func('void* FindWindowA(const char* lpClassName, const char* lpWindowName)');

const ABM_GETSTATE = 4;
const ABM_SETSTATE = 10;
const ABS_AUTOHIDE = 1;
const ABS_ALWAYSONTOP = 2;

const taskbar = FindWindowA('Shell_TrayWnd', null);
if (!taskbar) {
  console.log('Taskbar not found');
  process.exit(1);
}

const data = {
  cbSize: koffi.sizeof(APPBARDATA),
  hWnd: taskbar,
  uCallbackMessage: 0,
  uEdge: 0,
  rc: { left: 0, top: 0, right: 0, bottom: 0 },
  lParam: 0
};

const state = SHAppBarMessage(ABM_GETSTATE, data);
console.log('Current state:', state);

data.lParam = ABS_AUTOHIDE;
SHAppBarMessage(ABM_SETSTATE, data);
console.log('Set to autohide');

setTimeout(() => {
  data.lParam = state; // restore original state
  SHAppBarMessage(ABM_SETSTATE, data);
  console.log('Restored state:', state);
}, 3000);
