export declare const desktopDownloadPage = "https://offline.tldraw.com";
export interface ReleaseAsset {
    readonly name: string;
    readonly browser_download_url: string;
    readonly size: number;
    readonly digest: string | null;
}
interface Release {
    readonly tag_name: string;
    readonly html_url: string;
    readonly assets: readonly ReleaseAsset[];
}
export declare function selectDesktopAsset(release: Release, platform?: NodeJS.Platform, architecture?: string): ReleaseAsset;
export declare function getLatestDesktopRelease(): Promise<Release>;
export declare function installDesktop(options: {
    readonly downloadOnly?: boolean;
}): Promise<{
    readonly filePath: string;
    readonly release: string;
}>;
export declare function findDesktopApplication(): Promise<string | null>;
export declare function desktopStatus(): Promise<{
    readonly installedPath: string | null;
    readonly server: {
        readonly port: number;
        readonly pid: number | null;
    } | null;
}>;
export declare function openInDesktop(filePath: string): Promise<void>;
export {};
