import type { GenerationTaskProjection } from "@infinite-canvas/contracts";
import { App, Button, Empty, Result, Segmented, Space, Spin, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { RefreshCw, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { cancelCloudGenerationJob, listCloudGenerationJobs, retryCloudGenerationJob } from "@/services/api/cloud-generation";
import { useUserStore } from "@/stores/use-user-store";

const terminal = new Set(["succeeded", "failed", "canceled", "outcome_unknown", "cancel_requested"]);

function statusColor(status: string): string {
    if (status === "succeeded") return "success";
    if (status === "failed") return "error";
    if (status === "outcome_unknown") return "warning";
    if (status === "canceled") return "default";
    return "processing";
}

export default function TasksPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const authReady = useUserStore((state) => state.authReady);
    const authenticated = useUserStore((state) => state.authenticated);
    const wallet = useUserStore((state) => state.wallet);
    const openSignIn = useUserStore((state) => state.setAuthDialogOpen);
    const [jobs, setJobs] = useState<GenerationTaskProjection[]>([]);
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState("all");
    const [actingJobId, setActingJobId] = useState<string>();

    const refresh = useCallback(
        async (silent = false) => {
            if (!authenticated) return;
            if (!silent) setLoading(true);
            try {
                const response = await listCloudGenerationJobs();
                setJobs(response.jobs);
            } catch (error) {
                if (!silent) message.error(error instanceof Error ? error.message : t("tasks.loadFailed"));
            } finally {
                if (!silent) setLoading(false);
            }
        },
        [authenticated, message, t],
    );

    useEffect(() => {
        if (!authenticated) return;
        void refresh();
        const timer = window.setInterval(() => void refresh(true), 5000);
        return () => window.clearInterval(timer);
    }, [authenticated, refresh]);

    const visibleJobs = useMemo(() => jobs.filter((job) => filter === "all" || (filter === "active" ? !terminal.has(job.status) : job.status === filter)), [filter, jobs]);

    const retry = async (job: GenerationTaskProjection) => {
        setActingJobId(job.jobId);
        try {
            await retryCloudGenerationJob(job.jobId, `task-retry:${job.attemptId}`);
            await refresh(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("tasks.actionFailed"));
        } finally {
            setActingJobId(undefined);
        }
    };

    const cancel = async (job: GenerationTaskProjection) => {
        setActingJobId(job.jobId);
        try {
            await cancelCloudGenerationJob(job.jobId);
            await refresh(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("tasks.actionFailed"));
        } finally {
            setActingJobId(undefined);
        }
    };

    if (!authReady)
        return (
            <div className="flex h-full items-center justify-center">
                <Spin />
            </div>
        );
    if (!authenticated)
        return (
            <Result
                status="403"
                title={t("tasks.signInTitle")}
                subTitle={t("tasks.signInDescription")}
                extra={
                    <Button type="primary" onClick={() => openSignIn(true)}>
                        {t("cloud.signIn")}
                    </Button>
                }
            />
        );

    return (
        <main className="h-full overflow-y-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
                <div className="flex flex-col gap-4 border-b border-stone-200 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-stone-800">
                    <div>
                        <h1 className="text-xl font-semibold">{t("tasks.title")}</h1>
                        <p className="mt-1 text-sm text-stone-500">{t("tasks.description")}</p>
                    </div>
                    <Space wrap>
                        <Typography.Text type="secondary">{t("tasks.wallet", { available: wallet?.available ?? "0", reserved: wallet?.reserved ?? "0" })}</Typography.Text>
                        <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()} aria-label={t("tasks.refresh")}>
                            {t("tasks.refresh")}
                        </Button>
                    </Space>
                </div>
                <div className="py-4">
                    <Segmented
                        value={filter}
                        onChange={(value) => setFilter(String(value))}
                        options={[
                            { label: t("common.all"), value: "all" },
                            { label: t("tasks.active"), value: "active" },
                            { label: t("workbench.success"), value: "succeeded" },
                            { label: t("workbench.failed"), value: "failed" },
                            { label: t("tasks.unknown"), value: "outcome_unknown" },
                        ]}
                    />
                </div>
                <Table<GenerationTaskProjection>
                    rowKey="jobId"
                    loading={loading}
                    dataSource={visibleJobs}
                    locale={{ emptyText: <Empty description={t("tasks.empty")} /> }}
                    scroll={{ x: 900 }}
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    columns={[
                        { title: t("tasks.type"), dataIndex: "capability", width: 90, render: (value) => t(`tasks.capabilities.${value}`) },
                        { title: t("tasks.status"), dataIndex: "status", width: 150, render: (value) => <Tag color={statusColor(value)}>{t(`tasks.statuses.${value}`, { defaultValue: value })}</Tag> },
                        { title: t("tasks.slot"), width: 110, render: (_, job) => `#${job.slotIndex + 1} / ${job.attemptNo}` },
                        { title: t("tasks.error"), ellipsis: true, render: (_, job) => job.errorMessage || job.errorCode || "-" },
                        { title: t("common.updated", { date: "" }).replace(/[:：]\s*$/, ""), dataIndex: "updatedAt", width: 180, render: (value) => dayjs(value).format("YYYY-MM-DD HH:mm:ss") },
                        {
                            title: t("tasks.actions"),
                            fixed: "right",
                            width: 160,
                            render: (_, job) => (
                                <Space>
                                    {job.status === "failed" || job.status === "canceled" ? (
                                        <Button type="text" icon={<RotateCcw className="size-4" />} loading={actingJobId === job.jobId} onClick={() => void retry(job)} aria-label={t("workbench.retry")} title={t("workbench.retry")} />
                                    ) : null}
                                    {!terminal.has(job.status) && job.status !== "outcome_unknown" && job.status !== "cancel_requested" ? (
                                        <Button type="text" danger icon={<Square className="size-4" />} loading={actingJobId === job.jobId} onClick={() => void cancel(job)} aria-label={t("common.cancel")} title={t("common.cancel")} />
                                    ) : null}
                                </Space>
                            ),
                        },
                    ]}
                />
            </div>
        </main>
    );
}
