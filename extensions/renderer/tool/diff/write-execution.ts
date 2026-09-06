import * as PiAgent from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";

export type NativeWriteToolFactory = typeof PiAgent.createWriteToolDefinition;
type NativeWriteArguments = Parameters<ReturnType<NativeWriteToolFactory>["execute"]>;
type NativeWriteResult = Awaited<ReturnType<ReturnType<NativeWriteToolFactory>["execute"]>>;

export const MAX_COMPARABLE_WRITE_BYTES = 512_000;
export const MAX_WRITE_METADATA_ENTRIES = 100;

export type WriteExecutionMeta = {
	fileExistedBeforeWrite: boolean;
	previousContent?: string;
	diffUnavailableReason?: string;
};

export class WriteExecutionMetadataStore {
	readonly entries = new Map<string, WriteExecutionMeta>();
	/** Hosts without Pi's write factory retain their native execution and renderer. */
	useNativeRenderer = false;

	set(toolCallId: string, metadata: WriteExecutionMeta): void {
		this.entries.delete(toolCallId);
		this.entries.set(toolCallId, metadata);
		while (this.entries.size > MAX_WRITE_METADATA_ENTRIES) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	get(toolCallId: unknown): WriteExecutionMeta | undefined {
		return typeof toolCallId === "string" ? this.entries.get(toolCallId) : undefined;
	}

	delete(toolCallId: string): void {
		this.entries.delete(toolCallId);
	}

	clear(): void {
		this.entries.clear();
	}
}

async function capturePreviousContent(absolutePath: string): Promise<WriteExecutionMeta> {
	let info;
	try {
		info = await lstat(absolutePath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return { fileExistedBeforeWrite: false };
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "unable to inspect the previous file",
		};
	}

	if (!info.isFile()) {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "previous path is not a regular file",
		};
	}
	if (info.size > MAX_COMPARABLE_WRITE_BYTES) {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: `previous file exceeds ${MAX_COMPARABLE_WRITE_BYTES} bytes`,
		};
	}

	try {
		const bytes = await readFile(absolutePath);
		const previousContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { fileExistedBeforeWrite: true, previousContent };
	} catch {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "previous file is not comparable UTF-8 text",
		};
	}
}

export async function executeWriteWithMetadata(
	store: WriteExecutionMetadataStore,
	toolCallId: string,
	params: { path: string; content: string },
	signal: AbortSignal | undefined,
	cwd: string,
	createNativeWrite: NativeWriteToolFactory | undefined = PiAgent.createWriteToolDefinition,
	onUpdate?: NativeWriteArguments[3],
	ctx?: NativeWriteArguments[4],
): Promise<NativeWriteResult> {
	store.delete(toolCallId);
	try {
		if (typeof createNativeWrite !== "function") {
			throw new Error("This host does not expose Pi's native write tool factory");
		}
		let metadata: WriteExecutionMeta | undefined;
		const nativeWrite = createNativeWrite(cwd, {
			operations: {
				mkdir: async (directory) => {
					await mkdir(directory, { recursive: true });
				},
				async writeFile(absolutePath, content) {
					// The native tool resolves the path and owns its mutation queue. Capture
					// inside that queue, immediately before writing, without nesting locks.
					metadata = await capturePreviousContent(absolutePath);
					if (signal?.aborted) throw new Error("Operation aborted");
					await writeFile(absolutePath, content, "utf8");
				},
			},
		});
		const result = await nativeWrite.execute(
			toolCallId,
			params,
			signal,
			onUpdate,
			ctx ?? ({ cwd } as NativeWriteArguments[4]),
		);
		if (metadata) store.set(toolCallId, metadata);
		return result;
	} catch (error) {
		store.delete(toolCallId);
		throw error;
	}
}
