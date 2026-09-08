const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
const assets = [
    'views/pdf-viewer/vendor/build/pdf.js',
    'views/pdf-viewer/vendor/build/pdf.worker.js',
    'views/pdf-viewer/vendor/web/viewer.html',
    'views/pdf-viewer/vendor/web/viewer.js',
    'views/pdf-viewer/vendor/web/viewer.css',
    ...manifest.contributes.languages.map(language => language.configuration).filter(Boolean),
];
const missing = assets.filter(asset => !fs.existsSync(path.join(root, asset)));
if (missing.length) {
    throw new Error('Required extension assets are missing: ' + missing.join(', ') + '. Run npm run download-pdfjs and npm run download-latex-basics before packaging.');
}
const pdf = fs.readFileSync(path.join(root, assets[0]), 'utf8');
if (!pdf.includes('ViewerFontColor') || !pdf.includes('ViewerBgColor')) {
    throw new Error('The PDF.js rendering patch has not been applied.');
}
console.log('Validated PDF.js assets, rendering hooks, and declared language configurations.');
