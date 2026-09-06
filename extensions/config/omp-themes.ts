import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_DIR } from "./config.ts";

/** OMP does not discover themes from plugin manifests. Install on explicit request. */
export async function installOmpThemes(): Promise<string[]> {
	const directory = join(AGENT_DIR, "themes");
	await mkdir(directory, { recursive: true });
	const installed: string[] = [];
	for (const name of ["cc-dark", "cc-light"]) {
		try {
			await copyFile(
				new URL(`../../themes/omp/${name}.json`, import.meta.url),
				join(directory, `${name}.json`),
				constants.COPYFILE_EXCL,
			);
			installed.push(name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	return installed;
}
