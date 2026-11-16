type IconName = 'correct' | 'incorrect' | 'pending' | 'review' | 'radio';
const NS = 'http://www.w3.org/2000/svg';
type Shape = [string, Record<string, string>];
const shapes: Record<IconName, Shape[]> = {
  correct: [['circle', { cx: '12', cy: '12', r: '9' }]],
  incorrect: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  pending: [5, 12, 19].map(cx => ['circle', { cx: String(cx), cy: '12', r: '1.5', fill: 'currentColor', stroke: 'none' }]),
  review: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4' }], ['circle', { cx: '12', cy: '17', r: '.8', fill: 'currentColor', stroke: 'none' }]],
  radio: [['circle', { cx: '12', cy: '12', r: '9' }], ['circle', { cx: '12', cy: '12', r: '4', fill: 'currentColor', stroke: 'none', class: 'radio-dot' }]],
};
export function icon(name: IconName, className: string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: className })) svg.setAttribute(key, value);
  for (const [tag, attrs] of shapes[name]) {
    const shape = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.appendChild(shape);
  }
  return svg;
}
