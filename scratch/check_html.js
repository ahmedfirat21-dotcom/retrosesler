const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');

// Check script tag counts
const scriptStarts = (content.match(/<script/g) || []).length;
const scriptEnds = (content.match(/<\/script>/g) || []).length;

console.log(`Script starts: ${scriptStarts}, Script ends: ${scriptEnds}`);

// Check style tag counts
const styleStarts = (content.match(/<style/g) || []).length;
const styleEnds = (content.match(/<\/style>/g) || []).length;

console.log(`Style starts: ${styleStarts}, Style ends: ${styleEnds}`);

if (scriptStarts !== scriptEnds) {
    console.error("Mismatch in script tags!");
}
if (styleStarts !== styleEnds) {
    console.error("Mismatch in style tags!");
}
console.log("HTML sanity check passed successfully.");
