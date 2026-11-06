const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\s+/).map(BigInt);
console.log((a + b + 1n).toString());
