// The bed is its own little window; the main process moves it. This only reports when it is
// grabbed and let go.
const el = document.getElementById('bed');
let held = false;

el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  held = true;
  el.setPointerCapture(e.pointerId);
  window.bed.drag(true);
});

function release() {
  if (!held) return;
  held = false;
  window.bed.drag(false);
}
el.addEventListener('pointerup', release);
el.addEventListener('pointercancel', release);
window.addEventListener('blur', release);
