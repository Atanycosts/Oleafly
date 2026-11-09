import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { effortChoicesFor, type EffortLevel } from "@oleafly/ai-core";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { EffortSelector } from "@/components/ai/composer/EffortSelector";
import {
	deriveProviderState,
	loadProviderConfig,
} from "@/components/ai/provider-config";
import { useTauriSubscription } from "@/hooks/use-tauri-event";
import { configuredModelGroups } from "@/lib/ai-model-groups";
import { getResearchWorkspace } from "@/lib/research-workspace";
import { defaultBrief, type ResearchTask } from "@/lib/research-tasks";
import {
	capturedJournalFile,
	formatJournalValue,
	createJournalResearch,
	journalRequest,
	journalResearchPrompt,
	journalUnitScale,
	loadJournalResearchResult,
	type JournalCheck,
	type JournalResearchResult,
	type JournalWorld,
} from "@/lib/journal-workbench";
import {
	mountResearchTaskSubscriptions,
	useResearchTasksStore,
} from "@/store/research-tasks";
import {
	setResearchTasksEnabled,
	useResearchTasksEnabled,
} from "@/store/research-tasks-flag";
import { useChatsStore } from "@/store/chats";
import { useSettingsStore } from "@/store/settings";
import { phaseLabel, statusLabel } from "./tasks/task-status";

const selectClass =
	"h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";

async function candidatePayload(
	result: JournalResearchResult,
	versionId: string,
) {
	return {
		version_id: versionId,
		...(await capturedJournalFile(
			new File([JSON.stringify(result.component)], "journal-research.json"),
		)),
		sources: result.sources,
	};
}

export function JournalResearchPanel({
	projectId,
	world,
	check,
	manuscriptId,
	onAdopted,
}: {
	projectId: string;
	world: JournalWorld;
	check: JournalCheck | null;
	manuscriptId: string | null;
	onAdopted: (world: JournalWorld, checked: boolean) => Promise<void>;
}) {
	const { t, i18n } = useTranslation("researchTools");
	const text = t(($) => $.researchTools.journal, { returnObjects: true });
	const enabled = useResearchTasksEnabled();
	const formId = useId();
	const tasks = useResearchTasksStore((state) => state.tasks);
	const [link, setLink] = useState<{
		taskId: string;
		worldVersionId: string;
	} | null>(null);
	const task = tasks.find((item) => item.id === link?.taskId) ?? null;
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<JournalResearchResult | null>(null);
	const [preview, setPreview] = useState<JournalWorld | null>(null);
	const [selected, setSelected] = useState<
		Record<string, { expected: string; confirm: boolean }>
	>({});
	const [reason, setReason] = useState("");
	const [checkAfter, setCheckAfter] = useState(true);
	const [request, setRequest] = useState("");
	const [urls, setUrls] = useState("");
	const [minutes, setMinutes] = useState(30);
	const [effort, setEffort] = useState<EffortLevel | undefined>();
	const [groups, setGroups] = useState<
		ReturnType<typeof configuredModelGroups>
	>([]);
	const [model, setModel] = useState("");
	const [configReady, setConfigReady] = useState(false);
	const choice = groups
		.flatMap((group) => group.models.map((entry) => ({ group, entry })))
		.find(({ group, entry }) => JSON.stringify([group.id, entry.id]) === model);
	const choices = choice
		? effortChoicesFor(choice.group.id, choice.entry.id, choice.entry.metadata)
		: [];

	async function perform(action: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	useTauriSubscription(
		mountResearchTaskSubscriptions,
		"journal research tasks",
	);
	useEffect(() => {
		const store = useResearchTasksStore.getState();
		if (store.projectId === projectId) void store.refresh();
		else void store.bindProject(projectId);
		void getResearchWorkspace(projectId)
			.then((workspace) => {
				setLink(workspace.journalResearch ?? null);
			})
			.catch((cause) => setError(String(cause)));
	}, [projectId]);

	useEffect(() => {
		if (!open || configReady) return;
		void loadProviderConfig()
			.then((config) => {
				const state = deriveProviderState(config);
				setGroups(
					configuredModelGroups(
						{
							keys: state.keysMap,
							customProviders: state.customProviders,
							providerModels: state.providerModelsMap,
						},
						{
							keep: { providerId: state.provider, modelId: state.model },
							toModel: (_provider, entry) => ({
								id: entry.id,
								name: entry.name,
								metadata: entry.metadata,
							}),
						},
					),
				);
				setModel(JSON.stringify([state.provider, state.model]));
				const chats = useChatsStore.getState();
				setEffort(
					chats.chats.find((chat) => chat.id === chats.activeId)?.effort,
				);
				setConfigReady(true);
			})
			.catch((cause) => setError(String(cause)));
	}, [open, configReady]);

	const baseVersion = link?.worldVersionId ?? world.version_id;
	const readResult = useCallback(
		async (finished: ResearchTask) => {
			const saved = await loadJournalResearchResult(finished.id);
			const analyzed = saved.component
				? await journalRequest<JournalWorld>("/api/world-component", {
						...(await candidatePayload(saved, baseVersion)),
						preview: true,
					})
				: null;
			setResult(saved);
			setPreview(analyzed);
			setSelected(
				Object.fromEntries(
					(saved.component?.rules ?? []).map((rule) => [
						rule.property,
						{
							expected: String(
								Number(
									(rule.expected / journalUnitScale(rule.unit)).toFixed(4),
								),
							),
							confirm: false,
						},
					]),
				),
			);
		},
		[baseVersion],
	);

	useEffect(() => {
		if (!task?.result) return;
		void readResult(task).catch((cause) => setError(String(cause)));
	}, [task, readResult]);

	async function start() {
		if (!choice) return;
		const brief = defaultBrief(text.researchGoal);
		brief.permissions = { network: true, commands: "off", desktopApps: false };
		brief.budget.wallClockMinutes = minutes;
		brief.reasoningEffort = effort && choices.includes(effort) ? effort : null;
		brief.successCriteria = [text.researchSuccess];
		const created = await createJournalResearch(
			{
				projectId,
				title: `${text.researchTitle} · ${world.journal_name}`,
				runtimeId: "builtin",
				agentId: choice.group.id,
				modelId: choice.entry.id,
				skillIds: [],
				dependencyIds: [],
				brief,
				prompt: journalResearchPrompt(
					world,
					i18n.resolvedLanguage ?? i18n.language,
					request,
					urls,
				),
			},
			world.version_id,
			check?.check_id ?? null,
		);
		const store = useResearchTasksStore.getState();
		store.receiveTask(created);
		setLink({ taskId: created.id, worldVersionId: world.version_id });
		setResult(null);
		setPreview(null);
		await store.startTask(created.id);
		setOpen(false);
	}

	async function adopt() {
		if (!result?.component) return;
		const rules = result.component.rules.filter(
			(rule) => selected[rule.property],
		);
		const sources = new Set(rules.flatMap((rule) => rule.source_refs));
		const edited = {
			...result,
			component: {
				...result.component,
				sources: result.component.sources.filter((source) =>
					sources.has(source.source_id),
				),
				rules: rules.map((rule) => ({
					...rule,
					expected: Math.round(
						Number(selected[rule.property].expected) *
							journalUnitScale(rule.unit),
					),
				})),
			},
		};
		const next = await journalRequest<JournalWorld>("/api/world-component", {
			...(await candidatePayload(edited, world.version_id)),
			decisions: rules
				.filter((rule) => selected[rule.property].confirm)
				.map((rule) => ({
					property: rule.property,
					expected: Math.round(
						Number(selected[rule.property].expected) *
							journalUnitScale(rule.unit),
					),
					reason,
				})),
		});
		// Surface a partial outcome if binding/checking fails; do not create the version again.
		await onAdopted(next, false);
		setOpen(false);
		if (checkAfter && manuscriptId) {
			const state = await journalRequest<{
				projects: {
					project_id: string;
					binding: { binding_id: string } | null;
				}[];
			}>("/api/state");
			const project = state.projects.find(
				(item) => item.project_id === manuscriptId,
			);
			await journalRequest("/api/bind", {
				project_id: manuscriptId,
				world_version_id: next.version_id,
				expected_binding_id: project?.binding?.binding_id ?? null,
			});
			await journalRequest("/api/check", { project_id: manuscriptId });
			await onAdopted(next, true);
		}
	}

	const active =
		task && ["running", "queued", "plan_ready"].includes(task.status);
	const confirmationNeeded = Object.values(selected).some((row) => row.confirm);
	return (
		<section
			className="min-w-0 space-y-2 rounded-lg border border-sidebar-border p-3 [&>button]:h-auto [&>button]:min-h-8 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:break-words [&>button]:py-2 [&>button]:text-left [&>div>button]:h-auto [&>div>button]:min-h-8 [&>div>button]:max-w-full [&>div>button]:whitespace-normal [&>div>button]:break-words [&>div>button]:py-2 [&>div>button]:text-left"
			data-testid="journal-research-panel"
		>
			<Button
				size="sm"
				variant="outline"
				className="w-full justify-start"
				disabled={busy || Boolean(active)}
				onClick={() => {
					setOpen(true);
					setError(null);
				}}
			>
				<Sparkles className="mr-1 size-3.5" />
				{text.researchTitle}
			</Button>
			{task && (
				<>
					<p className="break-words text-xs">
						{statusLabel(task.status)} · {task.modelId}
					</p>
					{task.phase && active && (
						<p className="text-xs text-muted-foreground">{phaseLabel(task.phase)}</p>
					)}
					{task.error && (
						<p role="alert" className="text-xs text-destructive">
							{task.error}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						{active && (
							<Button
								size="sm"
								variant="ghost"
								disabled={busy}
								onClick={() =>
									void perform(async () => {
										await useResearchTasksStore.getState().cancelTask(task.id);
									})
								}
							>
								{text.cancelResearch}
							</Button>
						)}
						{task.result && (
							<Button
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() =>
									void perform(async () => {
										await readResult(task);
										setOpen(true);
									})
								}
							>
								{text.reviewResearch}
							</Button>
						)}
						{task.status === "queued" && !task.startRequested && (
							<Button
								size="sm"
								disabled={busy}
								onClick={() =>
									void perform(async () => {
										await useResearchTasksStore.getState().startTask(task.id);
									})
								}
							>
								{text.startResearch}
							</Button>
						)}
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								useSettingsStore.getState().setRailTab("research");
								useResearchTasksStore.getState().openTaskDetail(task.id);
							}}
						>
							{text.openResearchTask}
						</Button>
					</div>
				</>
			)}
			{error && (
				<p role="alert" className="break-words text-xs text-destructive">
					{error}
				</p>
			)}
			<Dialog
				open={open}
				onOpenChange={(value) => {
					if (!busy) setOpen(value);
				}}
			>
				<DialogContent
					closeDisabled={busy}
					className="max-h-[85vh] max-w-3xl overflow-y-auto"
				>
					<DialogHeader>
						<DialogTitle>
							{result ? text.reviewResearch : text.researchTitle}
						</DialogTitle>
						<DialogDescription>
							{result ? text.adoptHelp : text.researchHelp}
						</DialogDescription>
					</DialogHeader>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					{result ? (
						<div className="space-y-4">
							<Markdown className="text-sm">{result.summary}</Markdown>
							{result.questions.length > 0 && (
								<section>
									<h3 className="font-medium">{text.researchQuestions}</h3>
									<ul className="list-disc space-y-1 pl-5 text-sm">
										{result.questions.map((question) => (
											<li key={question}>{question}</li>
										))}
									</ul>
								</section>
							)}
							{result.actions.length > 0 && (
								<section>
									<h3 className="font-medium">{text.researchActions}</h3>
									<ul className="list-disc space-y-1 pl-5 text-sm">
										{result.actions.map((action) => (
											<li key={action}>{action}</li>
										))}
									</ul>
								</section>
							)}
							{result.component?.rules.map((rule) => {
								const row = selected[rule.property];
								const prior = world.rules.find(
									(existing) => existing.property === rule.property,
								);
								const analyzed = preview?.rules.find(
									(existing) => existing.property === rule.property,
								);
								return (
									<section
										key={rule.property}
										className="space-y-2 rounded-md border p-3"
									>
										<label
											htmlFor={`${formId}-${rule.property}`}
											className="flex items-center gap-2 text-sm font-medium"
										>
											<Checkbox
												id={`${formId}-${rule.property}`}
												checked={Boolean(row)}
												disabled={busy}
												onCheckedChange={(checked) =>
													setSelected((previous) => {
														const next = { ...previous };
														if (checked)
															next[rule.property] = {
																expected: String(
																	Number(
																		(
																			rule.expected /
																			journalUnitScale(rule.unit)
																		).toFixed(4),
																	),
																),
																confirm: false,
															};
														else delete next[rule.property];
														return next;
													})
												}
											/>
											{
												text.properties[
													rule.property as keyof typeof text.properties
												]
											}
										</label>
										<div className="flex items-center gap-2 text-sm">
											<span>{text.expected}</span>
											<Input
												type="number"
												className="w-32"
												aria-label={`${text.expected}: ${rule.property}`}
												disabled={busy || !row}
												value={
													row?.expected ??
													rule.expected / journalUnitScale(rule.unit)
												}
												min={
													rule.property.includes("margin")
														? 0
														: rule.unit === "count"
															? 1
															: 0.01
												}
												step={rule.unit === "count" ? 1 : "any"}
												onChange={(event) =>
													setSelected((previous) => ({
														...previous,
														[rule.property]: {
															...previous[rule.property],
															expected: event.target.value,
														},
													}))
												}
											/>
											<span className="text-xs text-muted-foreground">
												{rule.unit === "count"
													? text.unitCount
													: rule.unit === "twips"
														? "mm"
														: "pt"}
											</span>
										</div>
										{prior && (
											<p className="text-xs text-muted-foreground">
												{text.before}:{" "}
												{formatJournalValue(prior.expected, prior.unit)} ·{" "}
												{text.bases[prior.basis_status]}
											</p>
										)}
										{analyzed?.basis_status === "conflict" && (
											<p className="text-xs text-amber-600">
												{text.bases.conflict}
											</p>
										)}
										{result.component?.sources
											.filter((source) =>
												rule.source_refs.includes(source.source_id),
											)
											.map((source) => (
												<blockquote
													key={source.source_id}
													className="border-l-2 pl-3 text-xs"
												>
													<p>{source.quote}</p>
													<p className="mt-1 break-all text-muted-foreground">
														{source.title} · {source.locator}
													</p>
												</blockquote>
											))}
										<label
											htmlFor={`${formId}-${rule.property}-confirm`}
											className="flex items-center gap-2 text-xs"
										>
											<Checkbox
												id={`${formId}-${rule.property}-confirm`}
												checked={row?.confirm ?? false}
												disabled={busy || !row}
												onCheckedChange={(confirm) =>
													setSelected((previous) => ({
														...previous,
														[rule.property]: {
															...previous[rule.property],
															confirm: Boolean(confirm),
														},
													}))
												}
											/>
											{text.confirmResearchRule}
										</label>
									</section>
								);
							})}
							{result.component && (
								<>
									<p className="text-xs text-muted-foreground">
										{result.component.applicability.basis}
									</p>
									{confirmationNeeded && (
										<label
											htmlFor={`${formId}-reason`}
											className="block space-y-1 text-sm"
										>
											{text.decisionReason}
											<Textarea
												id={`${formId}-reason`}
												aria-label={text.decisionReason}
												value={reason}
												disabled={busy}
												onChange={(event) => setReason(event.target.value)}
											/>
										</label>
									)}
									<label
										htmlFor={`${formId}-check`}
										className="flex items-center gap-2 text-sm"
									>
										<Checkbox
											id={`${formId}-check`}
											checked={checkAfter}
											disabled={busy || !manuscriptId}
											onCheckedChange={(value) => setCheckAfter(Boolean(value))}
										/>
										{text.adoptAndCheck}
									</label>
									<Button
										disabled={
											busy ||
											Object.keys(selected).length === 0 ||
											(confirmationNeeded && !reason.trim())
										}
										onClick={() => void perform(adopt)}
									>
										{busy ? text.working : text.adoptResearch}
									</Button>
								</>
							)}
							<Button
								variant="ghost"
								disabled={busy || Boolean(active)}
								onClick={() => {
									setResult(null);
									setPreview(null);
								}}
							>
								{text.researchAgain}
							</Button>
						</div>
					) : (
						<form
							className="space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								void perform(start);
							}}
						>
							<p className="text-sm">
								{world.journal_name} ·{" "}
								{
									text.articleTypes[
										world.scope.article_type as keyof typeof text.articleTypes
									]
								}{" "}
								/ {text.stages[world.scope.stage as keyof typeof text.stages]}
							</p>
							<label
								htmlFor={`${formId}-request`}
								className="block space-y-1 text-sm"
							>
								{text.researchRequest}
								<Textarea
									id={`${formId}-request`}
									aria-label={text.researchRequest}
									value={request}
									onChange={(event) => setRequest(event.target.value)}
								/>
							</label>
							<label
								htmlFor={`${formId}-urls`}
								className="block space-y-1 text-sm"
							>
								{text.officialUrls}
								<Textarea
									id={`${formId}-urls`}
									aria-label={text.officialUrls}
									rows={2}
									value={urls}
									onChange={(event) => setUrls(event.target.value)}
								/>
							</label>
							<label className="block space-y-1 text-sm">
								{text.researchModel}
								<select
									aria-label={text.researchModel}
									className={selectClass}
									value={model}
									required
									onChange={(event) => {
										setModel(event.target.value);
										setEffort(undefined);
									}}
								>
									{!groups.length && (
										<option value="">{text.configureModel}</option>
									)}
									{groups.map((group) => (
										<optgroup key={group.id} label={group.name}>
											{group.models.map((entry) => (
												<option
													key={entry.id}
													value={JSON.stringify([group.id, entry.id])}
												>
													{entry.name}
												</option>
											))}
										</optgroup>
									))}
								</select>
							</label>
							<EffortSelector
								choices={choices}
								value={effort}
								onChange={setEffort}
								disabled={busy}
							/>
							<label
								htmlFor={`${formId}-minutes`}
								className="flex items-center gap-2 text-sm"
							>
								{text.researchMinutes}
								<Input
									id={`${formId}-minutes`}
									className="w-24"
									type="number"
									min="1"
									max="1440"
									value={minutes}
									required
									onChange={(event) => setMinutes(Number(event.target.value))}
								/>
							</label>
							{!enabled ? (
								<Button
									type="button"
									disabled={busy}
									onClick={() =>
										void perform(async () => {
											await setResearchTasksEnabled(true);
										})
									}
								>
									{text.enableResearch}
								</Button>
							) : (
								<Button type="submit" disabled={busy || !choice}>
									{busy ? text.working : text.startResearch}
								</Button>
							)}
						</form>
					)}
				</DialogContent>
			</Dialog>
		</section>
	);
}
