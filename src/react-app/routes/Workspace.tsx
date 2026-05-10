import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import Editor from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Send, Wand2, Rocket, Save, FileCode2, Bot, Heart } from "lucide-react";
import { Button } from "../components/ui/Button";
import { api, streamChat } from "../lib/api";

type ChatMsg = { role: "user" | "assistant"; content: string };

export function Workspace() {
	const { slug = "" } = useParams();
	const [search] = useSearchParams();
	const project = useQuery({ queryKey: ["project", slug], queryFn: () => api.project(slug), enabled: !!slug });
	const files = useQuery({ queryKey: ["files", slug], queryFn: () => api.files(slug), enabled: !!slug });
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const [activePath, setActivePath] = useState<string>("");
	const [editorContent, setEditorContent] = useState("");
	const [dirty, setDirty] = useState(false);
	const [model, setModel] = useState("claude-sonnet-4-6");
	const [useCouncil, setUseCouncil] = useState(false);
	const [messages, setMessages] = useState<ChatMsg[]>([]);
	const [input, setInput] = useState("");
	const [streaming, setStreaming] = useState(false);
	const chatBottom = useRef<HTMLDivElement>(null);

	// Auto-fill initial prompt from /new
	useEffect(() => {
		const initial = search.get("initial");
		if (initial && messages.length === 0) {
			setInput(initial);
		}
	}, [search, messages.length]);

	useEffect(() => {
		const first = files.data?.files[0]?.path;
		if (!activePath && first) {
			setActivePath(first);
		}
	}, [files.data, activePath]);

	const fileContent = useQuery({
		queryKey: ["file", slug, activePath],
		queryFn: () => api.file(slug, activePath),
		enabled: !!slug && !!activePath,
	});
	useEffect(() => {
		if (fileContent.data) {
			setEditorContent(fileContent.data.content);
			setDirty(false);
		}
	}, [fileContent.data]);

	useEffect(() => {
		chatBottom.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	async function send() {
		if (!input.trim() || streaming) return;
		const userMsg: ChatMsg = { role: "user", content: input };
		const next = [...messages, userMsg];
		setMessages(next);
		setInput("");
		setStreaming(true);

		if (useCouncil) {
			try {
				const { runId } = await api.startCouncil(userMsg.content, project.data?.project.id);
				setMessages([...next, { role: "assistant", content: `🏛️ Council deliberating (run ${runId}). View the full transcript in the Council tab.` }]);
				const es = new EventSource(`/api/council/${runId}/stream`, { withCredentials: true } as EventSourceInit);
				let combined = "";
				es.onmessage = (ev) => {
					try {
						const d = JSON.parse(ev.data);
						if (d.type === "turn") {
							combined += `\n\n**${d.role}** (${d.model}):\n${d.content}`;
							setMessages((m) => {
								const copy = [...m];
								copy[copy.length - 1] = { role: "assistant", content: combined.trim() };
								return copy;
							});
						} else if (d.type === "done") {
							es.close();
							setStreaming(false);
						} else if (d.type === "error") {
							es.close();
							toast.error(d.message);
							setStreaming(false);
						}
					} catch {
						/* noop */
					}
				};
				es.onerror = () => {
					es.close();
					setStreaming(false);
				};
			} catch (e) {
				toast.error((e as Error).message);
				setStreaming(false);
			}
			return;
		}

		setMessages([...next, { role: "assistant", content: "" }]);
		try {
			let acc = "";
			for await (const ev of streamChat({
				messages: next,
				model,
				projectId: project.data?.project.id,
			})) {
				if (ev.type === "delta" && ev.text) {
					acc += ev.text;
					setMessages((m) => {
						const copy = [...m];
						copy[copy.length - 1] = { role: "assistant", content: acc };
						return copy;
					});
				} else if (ev.type === "error") {
					toast.error(ev.message ?? "Stream error");
				}
			}
		} catch (e) {
			const msg = (e as Error).message;
			toast.error(msg);
		} finally {
			setStreaming(false);
		}
	}

	async function save() {
		if (!activePath) return;
		try {
			await api.saveFile(slug, activePath, editorContent);
			setDirty(false);
			toast.success("Saved");
		} catch (e) {
			toast.error((e as Error).message);
		}
	}

	async function deploy() {
		try {
			const r = await api.deploy(slug);
			toast.success(`Deploy v${r.version} queued`);
		} catch (e) {
			toast.error((e as Error).message);
		}
	}

	return (
		<div className="grid h-full grid-cols-12 gap-0">
			{/* Chat panel */}
			<section className="col-span-12 flex flex-col border-r border-white/5 bg-black/20 lg:col-span-4">
				<header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
					<div className="text-sm font-semibold">{project.data?.project.name ?? "Loading…"}</div>
					<div className="flex items-center gap-2">
						<select
							value={model}
							onChange={(e) => setModel(e.target.value)}
							disabled={useCouncil}
							className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs disabled:opacity-50"
						>
							{(models.data?.models ?? []).map((m) => (
								<option key={m.id} value={m.id} disabled={!m.available}>
									{m.displayName} {!m.available && "🔒"}
								</option>
							))}
						</select>
						<button
							onClick={() => setUseCouncil((b) => !b)}
							className={
								"flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition " +
								(useCouncil
									? "border-accent-500/50 bg-accent-500/20 text-accent-500"
									: "border-white/10 text-zinc-400 hover:text-white")
							}
							title="Multi-Model Council mode"
						>
							<Bot className="h-3 w-3" /> Council
						</button>
					</div>
				</header>
				<div className="flex-1 space-y-3 overflow-auto p-4 scrollbar-thin">
					{messages.length === 0 && (
						<div className="grid h-full place-items-center text-center text-sm text-zinc-500">
							<div>
								<Wand2 className="mx-auto mb-3 h-8 w-8 text-brand-400" />
								<p>Tell me what to build, change, or fix.</p>
								<p className="mt-1 text-xs">Try: "Add a dark mode toggle to the header."</p>
							</div>
						</div>
					)}
					{messages.map((m, i) => (
						<div
							key={i}
							className={
								"rounded-xl border p-3 text-sm whitespace-pre-wrap " +
								(m.role === "user"
									? "border-brand-500/30 bg-brand-500/10"
									: "border-white/5 bg-white/5")
							}
						>
							<div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
								{m.role === "user" ? "You" : "AI"}
							</div>
							{m.content || (streaming && i === messages.length - 1 ? "…" : "")}
						</div>
					))}
					<div ref={chatBottom} />
				</div>
				<footer className="border-t border-white/5 p-3">
					<div className="flex items-end gap-2">
						<textarea
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									send();
								}
							}}
							placeholder={useCouncil ? "Describe the change — Council will deliberate…" : "Ask AI to change anything…"}
							rows={2}
							className="min-h-[44px] flex-1 resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
						/>
						<Button onClick={send} disabled={streaming} size="md">
							<Send className="h-4 w-4" />
						</Button>
					</div>
				</footer>
			</section>

			{/* Editor + preview */}
			<section className="col-span-12 flex flex-col lg:col-span-8">
				<header className="flex items-center justify-between border-b border-white/5 px-4 py-2">
					<div className="flex items-center gap-2 text-xs text-zinc-400">
						<FileCode2 className="h-3.5 w-3.5" />
						{activePath || "Select a file"}
						{dirty && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-400" />}
					</div>
					<div className="flex items-center gap-2">
						<Button size="sm" variant="secondary" onClick={save} disabled={!dirty}>
							<Save className="h-3.5 w-3.5" /> Save
						</Button>
						<Button size="sm" onClick={deploy}>
							<Rocket className="h-3.5 w-3.5" /> Deploy
						</Button>
					</div>
				</header>
				<div className="flex flex-1 overflow-hidden">
					<aside className="w-56 overflow-auto border-r border-white/5 bg-black/20 p-2 scrollbar-thin">
						{(files.data?.files ?? []).map((f) => (
							<button
								key={f.id}
								onClick={() => setActivePath(f.path)}
								className={
									"flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left text-xs transition " +
									(activePath === f.path ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5")
								}
							>
								{f.path}
							</button>
						))}
						{(files.data?.files ?? []).length === 0 && (
							<div className="px-2 py-1 text-xs text-zinc-500">No files yet. Ask the AI to scaffold.</div>
						)}
					</aside>
					<div className="flex flex-1 flex-col">
						<div className="flex-1">
							<Editor
								height="100%"
								theme="vs-dark"
								path={activePath}
								value={editorContent}
								onChange={(v) => {
									setEditorContent(v ?? "");
									setDirty(true);
								}}
								options={{
									minimap: { enabled: false },
									fontSize: 13,
									tabSize: 2,
									scrollBeyondLastLine: false,
								}}
							/>
						</div>
						<div className="hidden h-64 border-t border-white/5 bg-black/30 p-2 text-xs text-zinc-500 lg:block">
							<div className="mb-1 flex items-center gap-2 text-zinc-400">
								<Heart className="h-3 w-3" /> Live preview
							</div>
							<div className="grid h-full place-items-center rounded border border-white/5 bg-black/40 text-zinc-500">
								Preview iframe — WebContainers boots here after first save.
							</div>
						</div>
					</div>
				</div>
			</section>
		</div>
	);
}
