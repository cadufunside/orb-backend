console.log("Starting orb-backend (QR mode) ...");
import("./dist/index.js").catch(err => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
