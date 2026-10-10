// The room (the bed and whatever it has earned) is its own window; the main process moves it.
// This reports when it is grabbed and let go, and shows what Clawd says is in it.
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

// which earned things are out, how tall the plant has grown, how far the scarf has got, and
// whether the lamp is lit
window.bed.onState((s) => {
  const on = Array.isArray(s && s.on) ? s.on : [];
  for (const item of document.querySelectorAll('.item')) item.classList.toggle('on', on.includes(item.dataset.id));
  document.body.dataset.plant = Number(s && s.plant) || 0;
  document.body.dataset.scarf = Number(s && s.scarf) || 0;
  document.body.classList.toggle('night', !!(s && s.night));
});
