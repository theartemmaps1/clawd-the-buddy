// Muddy footprints, left foot then right, from one point to another. The main process puts
// the two points and his walking pace in the address (#x1,y1,x2,y2,pxPerSecond), so each
// print turns up just after he has stepped there, and closes the window when they have faded.
const [x1, y1, x2, y2, pace] = location.hash.slice(1).split(',').map(Number);
const NS = 'http://www.w3.org/2000/svg';
const len = Math.hypot(x2 - x1, y2 - y1);

if (Number.isFinite(len) && len > 0) {
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const turn = Math.atan2(uy, ux) * 180 / Math.PI + 90;
  const steps = Math.min(60, Math.floor(len / 34));
  for (let i = 1; i <= steps; i++) {
    const side = i % 2 ? 1 : -1;
    const wobble = Math.sin(i * 0.7) * 10; // he does not walk in a straight line
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 9 11');
    svg.setAttribute('class', 'print');
    // a pad and three toes
    for (const [x, y, w, h] of [[2, 5, 5, 5], [1, 6, 7, 3], [0, 2, 2, 2], [3, 0, 3, 3], [7, 2, 2, 2]]) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x);
      r.setAttribute('y', y);
      r.setAttribute('width', w);
      r.setAttribute('height', h);
      r.setAttribute('fill', '#5a3b22');
      svg.appendChild(r);
    }
    svg.style.left = Math.round(x1 + ux * i * 34 - uy * (side * 11 + wobble)) + 'px';
    svg.style.top = Math.round(y1 + uy * i * 34 + ux * (side * 11 + wobble)) + 'px';
    svg.style.transform = `rotate(${Math.round(turn)}deg)`;
    svg.style.animationDelay = Math.round((i * 34 * 1000) / (pace > 0 ? pace : 300)) + 'ms';
    document.body.appendChild(svg);
  }
}
