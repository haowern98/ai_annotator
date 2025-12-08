const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const svgPath = path.join(__dirname, 'logohi.svg');
const buildDir = path.join(__dirname, 'build');
const publicDir = path.join(__dirname, 'public');

async function convert() {
  // Ensure directories exist
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

  const svgBuffer = fs.readFileSync(svgPath);

  // Create 256x256 PNG for build folder
  await sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(path.join(buildDir, 'icon.png'));
  console.log('✓ Created build/icon.png (256x256)');

  // Create 256x256 PNG for public folder (runtime icon)
  await sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(path.join(publicDir, 'icon.png'));
  console.log('✓ Created public/icon.png (256x256)');

  // Create multiple sizes for ICO (Windows needs these)
  const sizes = [16, 32, 48, 64, 128, 256];
  for (const size of sizes) {
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(buildDir, `icon-${size}.png`));
  }
  console.log('✓ Created icon sizes for ICO conversion');

  console.log('\n⚠️  For Windows .ico file:');
  console.log('   Use https://icoconvert.com/ to combine the icon-*.png files into icon.ico');
  console.log('   Or install png-to-ico: npm install -g png-to-ico && png-to-ico build/icon-256.png > build/icon.ico');
}

convert().catch(console.error);
