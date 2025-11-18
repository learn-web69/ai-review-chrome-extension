#!/usr/bin/env node

/**
 * Script to resize a source image to multiple icon sizes using sips (macOS)
 * Usage: node create-icons.js <source-image-path> [output-dir]
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sourceImage = process.argv[2];
const outputDir = process.argv[3] || path.join(__dirname, "public", "icons");

if (!sourceImage) {
  console.error(
    "❌ Error: Please provide a source image path\n\nUsage: node create-icons.js <source-image> [output-dir]"
  );
  console.error("\nExample: node create-icons.js ./logo.png");
  process.exit(1);
}

if (!fs.existsSync(sourceImage)) {
  console.error(`❌ Error: Source image not found: ${sourceImage}`);
  process.exit(1);
}

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const sizes = [16, 48, 128];
const ext = path.extname(sourceImage).toLowerCase();

console.log(`📸 Converting logo: ${sourceImage}`);
console.log(`📁 Output directory: ${outputDir}\n`);

try {
  sizes.forEach((size) => {
    const outputFile = path.join(outputDir, `icon${size}.png`);

    // Use sips command to resize (available on macOS)
    execSync(
      `sips -z ${size} ${size} "${sourceImage}" --out "${outputFile}"`,
      { stdio: "pipe" }
    );

    const stats = fs.statSync(outputFile);
    console.log(
      `✅ Created: icon${size}.png (${size}x${size}) - ${stats.size} bytes`
    );
  });

  console.log(`\n✨ Successfully created all icon sizes!`);
  console.log(`📦 Icons are ready in: ${outputDir}`);
  console.log(`\nNext steps:\n  1. npm run build\n  2. Reload extension in Chrome`);
} catch (error) {
  console.error(`❌ Error during conversion:`, error.message);
  process.exit(1);
}
