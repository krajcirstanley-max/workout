// Build step: compile the JSX in v3.src.html ahead of time so the app
// launches instantly (no in-browser Babel). Run: node build.js
const babel = require('@babel/core');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const src = fs.readFileSync(path.join(dir, 'v3.src.html'), 'utf8');

const m = src.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!m) { console.error('No <script type="text/babel"> found in v3.src.html'); process.exit(1); }

const compiled = babel.transformSync(m[1], {
  presets: ['@babel/preset-react'],   // JSX only - leaves modern JS native (Safari runs it)
  compact: false, comments: false,
}).code;

let html = src
  // drop the in-browser Babel library - no longer needed
  .replace(/\s*<script src="[^"]*babel[^"]*"><\/script>/i, '')
  // swap the JSX block for the precompiled plain JS
  .replace(/<script type="text\/babel">[\s\S]*?<\/script>/,
    '<script>\n' + compiled.replace(/<\/script/gi, '<\\/script') + '\n</script>');

fs.writeFileSync(path.join(dir, 'v3.html'), html);
console.log('Built v3.html (' + Math.round(html.length / 1024) + ' KB, precompiled)');
