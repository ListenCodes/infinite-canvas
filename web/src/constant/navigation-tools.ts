import { FileText, ImagePlus, Images, ListChecks, Maximize2, Settings2, ShieldCheck, Video } from "lucide-react";

export const navigationTools = [
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "video",
        icon: Video,
    },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "tasks",
        icon: ListChecks,
    },
    {
        slug: "admin",
        icon: ShieldCheck,
        requiresAdmin: true,
    },
    {
        slug: "config",
        icon: Settings2,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
