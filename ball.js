// The ball is its own tiny window; the main process does the physics. This only reports when
// it is grabbed and let go.
const el = document.getElementById('ball');
let held = false;

el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  held = true;
  el.setPointerCapture(e.pointerId);
  window.ball.drag(true);
});

function release() {
  if (!held) return;
  held = false;
  window.ball.drag(false);
}
el.addEventListener('pointerup', release);
el.addEventListener('pointercancel', release);
window.addEventListener('blur', release);
