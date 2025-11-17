import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Copy manifest.json to dist
fs.copyFileSync(
  path.resolve(__dirname, "manifest.json"),
  path.resolve(__dirname, "dist", "manifest.json")
);

// Create icons directory in dist if it doesn't exist
const iconsDir = path.resolve(__dirname, "dist", "icons");
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Copy icons if they exist
const publicIconsDir = path.resolve(__dirname, "public", "icons");
if (fs.existsSync(publicIconsDir)) {
  const files = fs.readdirSync(publicIconsDir);
  files.forEach((file) => {
    fs.copyFileSync(
      path.resolve(publicIconsDir, file),
      path.resolve(iconsDir, file)
    );
  });
}

console.log("✅ Chrome extension assets copied successfully!");
