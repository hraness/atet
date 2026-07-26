import { GraphicsCloudError } from "./cloud-errors.js";
export declare const graphicsDiscoveryUrl = "https://hraness.graphics/.well-known/graphics-cli.json";
export declare const graphicsRedirectUri = "http://127.0.0.1:49671/oauth/callback";
export declare const graphicsProductionContract: Readonly<{
    readonly environment: "production";
    readonly apiBaseUrl: "https://hraness.graphics/api/v1";
    readonly operationsUrl: "https://hraness.graphics/api/v1/operations";
    readonly issuer: "https://account.hraness.com";
    readonly authorizationEndpoint: "https://account.hraness.com/api/auth/oauth2/authorize";
    readonly tokenEndpoint: "https://account.hraness.com/api/auth/oauth2/token";
    readonly revocationEndpoint: "https://account.hraness.com/api/auth/oauth2/revoke";
    readonly clientId: "hraness:graphics:production:v1";
    readonly resource: "https://hraness.com/suite";
    readonly generateImage: "https://hraness.graphics/api/v1/images/generate";
    readonly maximumPromptBytes: 8192;
    readonly maximumRawImageBytes: 3145728;
}>;
export declare const graphicsImageModels: readonly ["openai/gpt-image-1.5", "recraft/recraft-v4.1-utility"];
export declare const graphicsResponseMediaTypes: readonly ["image/webp"];
export declare const graphicsImageGenerationQuota: Readonly<{
    readonly accountDailyLimit: 10;
    readonly globalDailySafetyLimit: 100;
    readonly paymentEnforced: false;
    readonly period: "utc-day";
}>;
export type GraphicsImageModel = (typeof graphicsImageModels)[number];
export type GraphicsResponseMediaType = (typeof graphicsResponseMediaTypes)[number];
export interface GraphicsDiscoveryDocument {
    readonly schemaVersion: 1;
    readonly product: "graphics";
    readonly environment: typeof graphicsProductionContract.environment;
    readonly apiBaseUrl: typeof graphicsProductionContract.apiBaseUrl;
    readonly operationsUrl: typeof graphicsProductionContract.operationsUrl;
    readonly authorization: {
        readonly type: "oauth2-authorization-code";
        readonly issuer: typeof graphicsProductionContract.issuer;
        readonly authorizationEndpoint: typeof graphicsProductionContract.authorizationEndpoint;
        readonly tokenEndpoint: typeof graphicsProductionContract.tokenEndpoint;
        readonly revocationEndpoint: typeof graphicsProductionContract.revocationEndpoint;
        readonly clientId: typeof graphicsProductionContract.clientId;
        readonly redirectUri: typeof graphicsRedirectUri;
        readonly scopes: readonly ["openid", "offline_access"];
        readonly resource: typeof graphicsProductionContract.resource;
        readonly pkce: "S256";
    };
    readonly endpoints: {
        readonly generateImage: typeof graphicsProductionContract.generateImage;
    };
    readonly imageGeneration: {
        readonly access: "authenticated";
        readonly billing: "free-preview";
        readonly models: typeof graphicsImageModels;
        readonly maximumPromptBytes: typeof graphicsProductionContract.maximumPromptBytes;
        readonly maximumRawImageBytes: typeof graphicsProductionContract.maximumRawImageBytes;
        readonly imagesPerRequest: 1;
        readonly responseMediaTypes: readonly ["image/webp"];
        readonly quota: typeof graphicsImageGenerationQuota;
        readonly idempotency: {
            readonly header: "Idempotency-Key";
            readonly durable: true;
            readonly scope: "suite-account";
        };
    };
    readonly features: {
        readonly vectorize: {
            readonly access: "authenticated";
            readonly billing: "free";
            readonly execution: "local";
        };
    };
}
export type GraphicsFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare const graphicsDiscoveryMaximumBytes: number;
export declare const graphicsMaximumPromptBytes: 8192;
export declare const graphicsMaximumRawImageBytes: 3145728;
export declare function parseGraphicsDiscovery(value: unknown): GraphicsDiscoveryDocument;
export declare function readBoundedResponseBytes(response: Response, maximumBytes: number, error: GraphicsCloudError): Promise<Uint8Array>;
export declare function readBoundedJson(response: Response, maximumBytes: number, error: GraphicsCloudError): Promise<unknown>;
export declare function fetchGraphicsDiscovery(fetchImplementation?: GraphicsFetch): Promise<GraphicsDiscoveryDocument>;
