import { type GraphicsDiscoveryDocument, type GraphicsFetch } from "./discovery.js";
export declare const graphicsSecretsService = "com.hraness.graphics.cli";
export declare const graphicsSecretsName = "oauth2-tokens";
export interface GraphicsSecretStore {
    get(options: {
        readonly service: string;
        readonly name: string;
    }): Promise<string | null>;
    set(options: {
        readonly service: string;
        readonly name: string;
        readonly value: string;
    }): Promise<void>;
    delete(options: {
        readonly service: string;
        readonly name: string;
    }): Promise<boolean>;
}
export interface StoredGraphicsCredentials {
    readonly schemaVersion: 1;
    readonly issuer: string;
    readonly clientId: string;
    readonly resource: string;
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly expiresAt: number;
}
export interface GraphicsAuthStatus {
    readonly authenticated: boolean;
    readonly expiresAt: string | null;
    readonly refreshable: boolean;
}
export interface GraphicsAuthDependencies {
    readonly fetch?: GraphicsFetch;
    readonly now?: () => number;
    readonly openUrl?: (url: string) => Promise<void>;
    readonly secrets?: GraphicsSecretStore;
}
export declare function createPkcePair(): {
    readonly verifier: string;
    readonly challenge: string;
};
export declare function buildGraphicsAuthorizationUrl(discovery: GraphicsDiscoveryDocument, state: string, challenge: string): string;
export declare function loginGraphics(dependencies?: GraphicsAuthDependencies): Promise<GraphicsAuthStatus>;
export declare function getGraphicsAccessToken(discovery: GraphicsDiscoveryDocument, dependencies?: GraphicsAuthDependencies): Promise<string>;
/**
 * Prove that a current Graphics login exists for a local authenticated
 * feature. The access token is intentionally not returned because callers
 * such as vectorization do not send it or any source bytes to a server.
 */
export declare function requireGraphicsAuthentication(dependencies?: GraphicsAuthDependencies): Promise<GraphicsDiscoveryDocument>;
export declare function graphicsAuthStatus(dependencies?: GraphicsAuthDependencies): Promise<GraphicsAuthStatus>;
export declare function logoutGraphics(dependencies?: GraphicsAuthDependencies): Promise<{
    readonly removed: boolean;
    readonly revoked: boolean;
}>;
