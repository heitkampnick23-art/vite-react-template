import { Sparkles } from "lucide-react";
import { cn } from "../lib/cn";

export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
	return (
		<div className={cn("flex items-center gap-2", className)}>
			<div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 shadow-lg shadow-brand-500/30">
				<Sparkles className="h-4 w-4 text-white" />
			</div>
			{withText && (
				<span className="text-lg font-semibold tracking-tight">
					Generate <span className="gradient-text">AI</span>
				</span>
			)}
		</div>
	);
}
