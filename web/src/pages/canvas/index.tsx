import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Tag } from "antd";
import { CloudDownload, CloudUpload, Download, FileUp, Plus } from "lucide-react";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { CanvasExportFile } from "@/types/canvas-export";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { isDurableMigrationStorageKey } from "@/lib/canvas/cloud-migration-export-core";
import { parseCloudMigrationRollbackData, restoreCloudMigrationLocalAssets } from "@/lib/canvas/cloud-migration-restore-core";
import { useCloudMigration } from "@/hooks/use-cloud-migration";

export default function CanvasPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const cloudMigration = useCloudMigration();

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const enterProject = (id: string) => {
        navigate(`/canvas/${id}${agentQuery}`);
    };
    const createAndEnter = () => enterProject(createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    const migrateToCloud = async () => {
        try {
            if (cloudMigration.record?.status === "failed") await cloudMigration.retry();
            else await cloudMigration.start();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("cloud.migrationFailed"));
        }
    };
    const activateCloudMigration = () => {
        modal.confirm({
            title: t("cloud.activateMigration"),
            content: cloudMigration.localChangesSinceExport
                ? t("cloud.activateMigrationChangedConfirm")
                : t("cloud.activateMigrationConfirm"),
            okText: t("cloud.activateMigration"),
            onOk: () => cloudMigration.activate(),
        });
    };
    const verifyDigest = async (blob: Blob, expected: string) => {
        const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
        if (actual !== expected) throw new Error("migration object checksum mismatch");
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (projectFile) {
                const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
                await Promise.all(
                    data.projects.flatMap((project) =>
                        project.files.map(async (item) => {
                            const blob = zip.get(item.path);
                            if (!blob) return;
                            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                            await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                        }),
                    ),
                );
                data.projects.forEach((item) => importProject(item.project));
                message.success(t("canvas.imported", { count: data.projects.length }));
                return;
            }
            const manifestFile = zip.get("manifest.json");
            const migrationProjectsFile = zip.get("data/projects.json");
            const migrationAssetsFile = zip.get("data/assets.json");
            const migrationLocalAssetsFile = zip.get("data/local-assets.json");
            if (!manifestFile || !migrationProjectsFile || !migrationAssetsFile) throw new Error("missing projects.json");
            const manifestValue = JSON.parse(await manifestFile.text()) as Record<string, unknown>;
            if (!Array.isArray(manifestValue.files)) throw new Error("migration manifest files are invalid");
            const declaredFiles = new Map(
                manifestValue.files.map((value) => {
                    if (!value || typeof value !== "object") throw new Error("migration manifest file is invalid");
                    const file = value as Record<string, unknown>;
                    if (
                        typeof file.path !== "string" ||
                        typeof file.bytes !== "string" || !/^\d+$/.test(file.bytes) ||
                        typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
                    ) throw new Error("migration manifest file is invalid");
                    return [file.path, { bytes: Number(file.bytes), sha256: file.sha256 }] as const;
                }),
            );
            const verifyDeclaredFile = async (path: string, blob?: Blob, optional = false) => {
                const declared = declaredFiles.get(path);
                if (!declared) {
                    if (optional && !blob) return false;
                    throw new Error(`migration manifest is missing ${path}`);
                }
                if (!blob || !Number.isSafeInteger(declared.bytes) || declared.bytes < 0 || blob.size !== declared.bytes) {
                    throw new Error(`migration file is missing or truncated: ${path}`);
                }
                await verifyDigest(blob, declared.sha256);
                return true;
            };
            await verifyDeclaredFile("data/projects.json", migrationProjectsFile);
            await verifyDeclaredFile("data/assets.json", migrationAssetsFile);
            const hasLocalAssets = await verifyDeclaredFile("data/local-assets.json", migrationLocalAssetsFile, true);
            const rollback = parseCloudMigrationRollbackData(
                manifestValue,
                JSON.parse(await migrationProjectsFile.text()),
                JSON.parse(await migrationAssetsFile.text()),
                hasLocalAssets && migrationLocalAssetsFile ? JSON.parse(await migrationLocalAssetsFile.text()) : [],
            );
            const restoredUrls = new Map<string, string>();
            await Promise.all(
                rollback.assets.map(async (asset) => {
                    if (!isDurableMigrationStorageKey(asset.sourceId)) return;
                    const object = zip.get(`objects/${asset.sha256}`);
                    if (!object || object.size !== asset.bytes) throw new Error("migration object is missing or truncated");
                    await verifyDigest(object, asset.sha256);
                    const typedBlob = object.slice(0, object.size, asset.mime);
                    const url = await (asset.sourceId.startsWith("image:") ? setImageBlob(asset.sourceId, typedBlob) : setMediaBlob(asset.sourceId, typedBlob));
                    restoredUrls.set(asset.sourceId, url);
                }),
            );
            if (rollback.localAssets.length) {
                useAssetStore.getState().replaceAssets(
                    restoreCloudMigrationLocalAssets(rollback.localAssets, restoredUrls, useAssetStore.getState().assets) as Asset[],
                );
            }
            rollback.projects.forEach((project) => importProject({ ...project.document, title: project.title }));
            message.success(t("canvas.imported", { count: rollback.projects.length }));
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject(t("canvas.defaultTitle", { count: projects.length + 1 })) : projects[0]?.id || createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    }, [createProject, hydrated, mode, projects, t]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        {cloudMigration.record ? <Tag>{t(`cloud.migrationStatuses.${cloudMigration.record.status}`)}</Tag> : null}
                        {cloudMigration.record || cloudMigration.legacyRecord ? (
                            <Button
                                icon={<Download className="size-4" />}
                                onClick={() => {
                                    const archive = cloudMigration.record ?? cloudMigration.legacyRecord!;
                                    saveAs(archive.archive, `infinite-canvas-${cloudMigration.record ? "migration" : "legacy-migration"}-${archive.clientExportId}.zip`);
                                }}
                                title={t("cloud.downloadMigrationArchive")}
                                aria-label={t("cloud.downloadMigrationArchive")}
                            />
                        ) : null}
                        {cloudMigration.record?.status === "published" && !cloudMigration.record.activatedAt ? (
                            <Button disabled={cloudMigration.busy} icon={<CloudDownload className="size-4" />} onClick={activateCloudMigration}>
                                {t("cloud.activateMigration")}
                            </Button>
                        ) : null}
                        {cloudMigration.available && (!cloudMigration.record || cloudMigration.record.status === "failed") ? (
                            <Button disabled={!projects.length || cloudMigration.busy} loading={cloudMigration.busy} icon={<CloudUpload className="size-4" />} onClick={() => void migrateToCloud()}>
                                {cloudMigration.record?.status === "failed" ? t("cloud.retryMigration") : t("cloud.migrate")}
                            </Button>
                        ) : null}
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `${t("canvas.title")}-${selectedIds.length}`)}>
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    {t("canvas.deleteSelected")}
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                {t("canvas.deleteAll")}
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {t("canvas.import")}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
