import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
	plugins: [react(), tailwindcss(), cloudflare()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src/react-app"),
			"@worker": path.resolve(__dirname, "./src/worker"),
			"@shared": path.resolve(__dirname, "./src/shared"),
		},
	},
});
