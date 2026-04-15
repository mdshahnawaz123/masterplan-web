const props = require('./raw_props.json');
const names = new Set();
const map = {};
for (const p of props) {
  if (p.name) {
    let n = p.name;
    // strip out id/handle to see general categories like "Block Reference [34AB]"
    n = n.replace(/\[.*\]/, '');
    map[n] = (map[n] || 0) + 1;
  }
}
const sorted = Object.entries(map).sort((a,b) => b[1] - a[1]);
console.log('Top Names:', sorted.slice(0, 50));

const attrsMap = {};
for (const p of props) {
  if (p.properties && p.properties.Attributes) {
     const keys = Object.keys(p.properties.Attributes);
     for (const k of keys) {
        attrsMap[k] = (attrsMap[k] || 0) + 1;
     }
  }
}
console.log('Top Attributes:', Object.entries(attrsMap).sort((a,b) => b[1] - a[1]).slice(0, 50));

const sample = props.find(p => p.properties && p.properties.Attributes && Object.keys(p.properties.Attributes).length > 2);
if (sample) console.log('Sample with Attributes:', JSON.stringify(sample, null, 2));
