export declare const graphicsCredentialMutationPlatforms: readonly ["darwin", "linux"];
/**
 * Advanced coordination controls for embedders and deterministic tests.
 * Processes sharing credentials must share `directory`. It contains only
 * empty ticket/owner markers; OAuth material remains exclusively in secrets.
 */
export interface GraphicsCredentialMutationLeaseOptions {
    readonly directory?: string;
    readonly waitTimeoutMilliseconds?: number;
    readonly staleAfterMilliseconds?: number;
    readonly pollIntervalMilliseconds?: number;
    /**
     * Cancels lease waiting and is checked again immediately before a refresh
     * POST. A dispatched rotating-token exchange always completes and persists.
     */
    readonly signal?: AbortSignal;
    /** Test hook that may fail before delegating to the inode-bound touch. */
    readonly heartbeat?: (touch: () => Promise<void>) => Promise<void>;
}
export interface GraphicsCredentialMutationLeaseDependencies {
    readonly credentialLease?: GraphicsCredentialMutationLeaseOptions;
}
export type GraphicsCredentialMutationPurpose = "login" | "refresh" | "logout";
export interface GraphicsCredentialMutationLease {
    readonly assertOwned: () => Promise<void>;
    readonly release: () => Promise<void>;
}
export declare function isGraphicsCredentialMutationPlatformSupported(platform: NodeJS.Platform): platform is (typeof graphicsCredentialMutationPlatforms)[number];
export declare function assertGraphicsCredentialMutationPlatformSupported(purpose: GraphicsCredentialMutationPurpose, platform?: NodeJS.Platform): void;
export declare function throwIfGraphicsCredentialMutationCancelled(dependencies: GraphicsCredentialMutationLeaseDependencies, purpose: GraphicsCredentialMutationPurpose): void;
export declare function acquireGraphicsCredentialMutationLease(dependencies: GraphicsCredentialMutationLeaseDependencies, purpose: GraphicsCredentialMutationPurpose): Promise<GraphicsCredentialMutationLease>;
