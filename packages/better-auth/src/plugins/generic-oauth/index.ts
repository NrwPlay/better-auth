import { betterFetch } from "@better-fetch/fetch";
import { APIError } from "better-call";
import { z } from "zod";
import { createAuthEndpoint, sessionMiddleware } from "../../api";
import { setSessionCookie } from "../../cookies";
import {
	createAuthorizationURL,
	validateAuthorizationCode,
	type OAuth2Tokens,
	type OAuthProvider,
} from "../../oauth2";
import { handleOAuthUserInfo } from "../../oauth2/link-account";
import { generateState, parseState } from "../../oauth2/state";
import type { BetterAuthPlugin, User } from "../../types";
import { decodeJwt } from "jose";
import { BASE_ERROR_CODES } from "../../error/codes";
import { refreshAccessToken } from "../../oauth2/refresh-access-token";

/**
 * Configuration interface for generic OAuth providers.
 */
interface GenericOAuthConfig {
	/** Unique identifier for the OAuth provider */
	providerId: string;
	/**
	 * URL to fetch OAuth 2.0 configuration.
	 * If provided, the authorization and token endpoints will be fetched from this URL.
	 */
	discoveryUrl?: string;
	/**
	 * URL for the authorization endpoint.
	 * Optional if using discoveryUrl.
	 */
	authorizationUrl?: string;
	/**
	 * URL for the token endpoint.
	 * Optional if using discoveryUrl.
	 */
	tokenUrl?: string;
	/**
	 * URL for the user info endpoint.
	 * Optional if using discoveryUrl.
	 */
	userInfoUrl?: string;
	/** OAuth client ID */
	clientId: string;
	/** OAuth client secret */
	clientSecret: string;
	/**
	 * Array of OAuth scopes to request.
	 * @default []
	 */
	scopes?: string[];
	/**
	 * Custom redirect URI.
	 * If not provided, a default URI will be constructed.
	 */
	redirectURI?: string;
	/**
	 * OAuth response type.
	 * @default "code"
	 */
	responseType?: string;
	/**
	 * Prompt parameter for the authorization request.
	 * Controls the authentication experience for the user.
	 */
	prompt?: "none" | "login" | "consent" | "select_account";
	/**
	 * Whether to use PKCE (Proof Key for Code Exchange)
	 * @default false
	 */
	pkce?: boolean;
	/**
	 * Access type for the authorization request.
	 * Use "offline" to request a refresh token.
	 */
	accessType?: string;
	/**
	 * Custom function to fetch user info.
	 * If provided, this function will be used instead of the default user info fetching logic.
	 * @param tokens - The OAuth tokens received after successful authentication
	 * @returns A promise that resolves to a User object or null
	 */
	getUserInfo?: (tokens: OAuth2Tokens) => Promise<User | null>;
	/**
	 * Custom function to map the user profile to a User object.
	 */
	mapProfileToUser?: (profile: Record<string, any>) =>
		| {
				id?: string;
				name?: string;
				email?: string;
				image?: string;
				emailVerified?: boolean;
				[key: string]: any;
		  }
		| Promise<{
				id?: string;
				name?: string;
				email?: string;
				image?: string;
				emailVerified?: boolean;
				[key: string]: any;
		  }>;
	/**
	 * Additional search-params to add to the authorizationUrl.
	 * Warning: Search-params added here overwrite any default params.
	 */
	authorizationUrlParams?: Record<string, string>;
	/**
	 * Disable implicit sign up for new users. When set to true for the provider,
	 * sign-in need to be called with with requestSignUp as true to create new users.
	 */
	disableImplicitSignUp?: boolean;
	/**
	 * Disable sign up for new users.
	 */
	disableSignUp?: boolean;
	/**
	 * Authentication method for token requests.
	 * @default "post"
	 */
	authentication?: "basic" | "post";
}

interface GenericOAuthOptions {
	/**
	 * Array of OAuth provider configurations.
	 */
	config: GenericOAuthConfig[];
}

async function getUserInfo(
	tokens: OAuth2Tokens,
	finalUserInfoUrl: string | undefined,
) {
	if (tokens.idToken) {
		const decoded = decodeJwt(tokens.idToken) as {
			sub: string;
			email_verified: boolean;
			email: string;
			name: string;
			picture: string;
		};
		if (decoded) {
			if (decoded.sub && decoded.email) {
				return {
					id: decoded.sub,
					emailVerified: decoded.email_verified,
					image: decoded.picture,
					...decoded,
				};
			}
		}
	}

	if (!finalUserInfoUrl) {
		return null;
	}

	const userInfo = await betterFetch<{
		email: string;
		sub?: string;
		name: string;
		email_verified: boolean;
		picture: string;
	}>(finalUserInfoUrl, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${tokens.accessToken}`,
		},
	});
	return {
		id: userInfo.data?.sub,
		emailVerified: userInfo.data?.email_verified,
		email: userInfo.data?.email,
		image: userInfo.data?.picture,
		name: userInfo.data?.name,
		...userInfo.data,
	};
}

/**
 * A generic OAuth plugin that can be used to add OAuth support to any provider
 */
export const genericOAuth = (options: GenericOAuthOptions) => {
	const ERROR_CODES = {
		INVALID_OAUTH_CONFIGURATION: "Invalid OAuth configuration",
	} as const;
	return {
		id: "generic-oauth",
		init: (ctx) => {
			const genericProviders = options.config.map((c) => {
				let finalUserInfoUrl = c.userInfoUrl;
				return {
					id: c.providerId,
					name: c.providerId,
					createAuthorizationURL(data) {
						return createAuthorizationURL({
							id: c.providerId,
							options: {
								clientId: c.clientId,
								clientSecret: c.clientSecret,
								redirectURI: c.redirectURI,
							},
							authorizationEndpoint: c.authorizationUrl!,
							state: data.state,
							codeVerifier: c.pkce ? data.codeVerifier : undefined,
							scopes: c.scopes || [],
							redirectURI: `${ctx.baseURL}/oauth2/callback/${c.providerId}`,
						});
					},
					async validateAuthorizationCode(data) {
						let finalTokenUrl = c.tokenUrl;
						if (c.discoveryUrl) {
							const discovery = await betterFetch<{
								token_endpoint: string;
								userinfo_endpoint: string;
							}>(c.discoveryUrl, {
								method: "GET",
							});
							if (discovery.data) {
								finalTokenUrl = discovery.data.token_endpoint;
								finalUserInfoUrl = discovery.data.userinfo_endpoint;
							}
						}
						if (!finalTokenUrl) {
							throw new APIError("BAD_REQUEST", {
								message: "Invalid OAuth configuration. Token URL not found.",
							});
						}
						return validateAuthorizationCode({
							code: data.code,
							codeVerifier: data.codeVerifier,
							redirectURI: data.redirectURI,
							options: {
								clientId: c.clientId,
								clientSecret: c.clientSecret,
								redirectURI: c.redirectURI,
							},
							tokenEndpoint: finalTokenUrl,
						});
					},
					async refreshAccessToken(
						refreshToken: string,
					): Promise<OAuth2Tokens> {
						let finalTokenUrl = c.tokenUrl;
						if (c.discoveryUrl) {
							const discovery = await betterFetch<{
								token_endpoint: string;
							}>(c.discoveryUrl, {
								method: "GET",
							});
							if (discovery.data) {
								finalTokenUrl = discovery.data.token_endpoint;
							}
						}
						if (!finalTokenUrl) {
							throw new APIError("BAD_REQUEST", {
								message: "Invalid OAuth configuration. Token URL not found.",
							});
						}
						return refreshAccessToken({
							options: {
								clientId: c.clientId,
								clientSecret: c.clientSecret,
							},
							refreshToken,
							providerConfig: {
								tokenEndpoint: finalTokenUrl,
							},
						});
					},

					async getUserInfo(tokens) {
						if (!finalUserInfoUrl) {
							return null;
						}
						const userInfo = c.getUserInfo
							? await c.getUserInfo(tokens)
							: await getUserInfo(tokens, finalUserInfoUrl);
						if (!userInfo) {
							return null;
						}
						return {
							user: {
								id: userInfo?.id,
								email: userInfo?.email,
								emailVerified: userInfo?.emailVerified,
								image: userInfo?.image,
								name: userInfo?.name,
								...c.mapProfileToUser?.(userInfo),
							},
							data: userInfo,
						};
					},
				} as OAuthProvider;
			});
			return {
				context: {
					socialProviders: genericProviders.concat(ctx.socialProviders),
				},
			};
		},
		endpoints: {
			signInWithOAuth2: createAuthEndpoint(
				"/sign-in/oauth2",
				{
					method: "POST",
					body: z.object({
						providerId: z.string({
							description: "The provider ID for the OAuth provider",
						}),
						callbackURL: z
							.string({
								description: "The URL to redirect to after sign in",
							})
							.optional(),
						errorCallbackURL: z
							.string({
								description: "The URL to redirect to if an error occurs",
							})
							.optional(),
						newUserCallbackURL: z
							.string({
								description:
									"The URL to redirect to after login if the user is new",
							})
							.optional(),
						disableRedirect: z
							.boolean({
								description: "Disable redirect",
							})
							.optional(),
						scopes: z
							.array(z.string(), {
								message:
									"Scopes to be passed to the provider authorization request.",
							})
							.optional(),
						requestSignUp: z
							.boolean({
								description:
									"Explicitly request sign-up. Useful when disableImplicitSignUp is true for this provider",
							})
							.optional(),
					}),
					metadata: {
						openapi: {
							description: "Sign in with OAuth2",
							responses: {
								200: {
									description: "Sign in with OAuth2",
									content: {
										"application/json": {
											schema: {
												type: "object",
												properties: {
													url: {
														type: "string",
													},
													redirect: {
														type: "boolean",
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
				async (ctx) => {
					const { providerId } = ctx.body;
					const config = options.config.find(
						(c) => c.providerId === providerId,
					);
					if (!config) {
						throw new APIError("BAD_REQUEST", {
							message: `No config found for provider ${providerId}`,
						});
					}
					const {
						discoveryUrl,
						authorizationUrl,
						tokenUrl,
						clientId,
						clientSecret,
						scopes,
						redirectURI,
						responseType,
						pkce,
						prompt,
						accessType,
						authorizationUrlParams,
					} = config;
					let finalAuthUrl = authorizationUrl;
					let finalTokenUrl = tokenUrl;
					if (discoveryUrl) {
						const discovery = await betterFetch<{
							authorization_endpoint: string;
							token_endpoint: string;
						}>(discoveryUrl, {
							onError(context) {
								ctx.context.logger.error(context.error.message, context.error, {
									discoveryUrl,
								});
							},
						});
						if (discovery.data) {
							finalAuthUrl = discovery.data.authorization_endpoint;
							finalTokenUrl = discovery.data.token_endpoint;
						}
					}
					if (!finalAuthUrl || !finalTokenUrl) {
						throw new APIError("BAD_REQUEST", {
							message: ERROR_CODES.INVALID_OAUTH_CONFIGURATION,
						});
					}
					if (authorizationUrlParams) {
						const withAdditionalParams = new URL(finalAuthUrl);
						for (const [paramName, paramValue] of Object.entries(
							authorizationUrlParams,
						)) {
							withAdditionalParams.searchParams.set(paramName, paramValue);
						}
						finalAuthUrl = withAdditionalParams.toString();
					}

					const { state, codeVerifier } = await generateState(ctx);
					const authUrl = await createAuthorizationURL({
						id: providerId,
						options: {
							clientId,
							clientSecret,
							redirectURI,
						},
						authorizationEndpoint: finalAuthUrl,
						state,
						codeVerifier: pkce ? codeVerifier : undefined,
						scopes: ctx.body.scopes
							? [...ctx.body.scopes, ...(scopes || [])]
							: scopes || [],
						redirectURI: `${ctx.context.baseURL}/oauth2/callback/${providerId}`,
					});

					if (responseType && responseType !== "code") {
						authUrl.searchParams.set("response_type", responseType);
					}

					if (prompt) {
						authUrl.searchParams.set("prompt", prompt);
					}

					if (accessType) {
						authUrl.searchParams.set("access_type", accessType);
					}

					return ctx.json({
						url: authUrl.toString(),
						redirect: !ctx.body.disableRedirect,
					});
				},
			),
			oAuth2Callback: createAuthEndpoint(
				"/oauth2/callback/:providerId",
				{
					method: "GET",
					query: z.object({
						code: z
							.string({
								description: "The OAuth2 code",
							})
							.optional(),
						error: z
							.string({
								description: "The error message, if any",
							})
							.optional(),
						error_description: z
							.string({
								description: "The error description, if any",
							})
							.optional(),
						state: z
							.string({
								description: "The state parameter from the OAuth2 request",
							})
							.optional(),
					}),
					metadata: {
						openapi: {
							description: "OAuth2 callback",
							responses: {
								200: {
									description: "OAuth2 callback",
									content: {
										"application/json": {
											schema: {
												type: "object",
												properties: {
													url: {
														type: "string",
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
				async (ctx) => {
					const defaultErrorURL =
						ctx.context.options.onAPIError?.errorURL ||
						`${ctx.context.baseURL}/error`;
					if (ctx.query.error || !ctx.query.code) {
						throw ctx.redirect(
							`${defaultErrorURL}?error=${
								ctx.query.error || "oAuth_code_missing"
							}&error_description=${ctx.query.error_description}`,
						);
					}
					const provider = options.config.find(
						(p) => p.providerId === ctx.params.providerId,
					);

					if (!provider) {
						throw new APIError("BAD_REQUEST", {
							message: `No config found for provider ${ctx.params.providerId}`,
						});
					}
					let tokens: OAuth2Tokens | undefined = undefined;
					const parsedState = await parseState(ctx);

					const {
						callbackURL,
						codeVerifier,
						errorURL,
						requestSignUp,
						newUserURL,
						link,
					} = parsedState;
					const code = ctx.query.code;

					function redirectOnError(error: string) {
						throw ctx.redirect(
							`${
								errorURL || callbackURL || `${ctx.context.baseURL}/error`
							}?error=${error}`,
						);
					}

					let finalTokenUrl = provider.tokenUrl;
					let finalUserInfoUrl = provider.userInfoUrl;
					if (provider.discoveryUrl) {
						const discovery = await betterFetch<{
							token_endpoint: string;
							userinfo_endpoint: string;
						}>(provider.discoveryUrl, {
							method: "GET",
						});
						if (discovery.data) {
							finalTokenUrl = discovery.data.token_endpoint;
							finalUserInfoUrl = discovery.data.userinfo_endpoint;
						}
					}
					try {
						if (!finalTokenUrl) {
							throw new APIError("BAD_REQUEST", {
								message: "Invalid OAuth configuration.",
							});
						}
						tokens = await validateAuthorizationCode({
							code,
							codeVerifier: provider.pkce ? codeVerifier : undefined,
							redirectURI: `${ctx.context.baseURL}/oauth2/callback/${provider.providerId}`,
							options: {
								clientId: provider.clientId,
								clientSecret: provider.clientSecret,
								redirectURI: provider.redirectURI,
							},
							tokenEndpoint: finalTokenUrl,
						});
					} catch (e) {
						ctx.context.logger.error(
							e && typeof e === "object" && "name" in e
								? (e.name as string)
								: "",
							e,
						);
						throw redirectOnError("oauth_code_verification_failed");
					}

					if (!tokens) {
						throw new APIError("BAD_REQUEST", {
							message: "Invalid OAuth configuration.",
						});
					}
					const userInfo = (
						provider.getUserInfo
							? await provider.getUserInfo(tokens)
							: await getUserInfo(tokens, finalUserInfoUrl)
					) as User | null;

					if (!userInfo?.email) {
						ctx.context.logger.error("Unable to get user info", userInfo);
						throw redirectOnError("email_is_missing");
					}

					const mapUser = provider.mapProfileToUser
						? await provider.mapProfileToUser(userInfo)
						: null;

					if (link) {
						if (
							ctx.context.options.account?.accountLinking
								?.allowDifferentEmails !== true &&
							link.email !== userInfo.email.toLowerCase()
						) {
							return redirectOnError("email_doesn't_match");
						}
						const newAccount = await ctx.context.internalAdapter.createAccount({
							userId: link.userId,
							providerId: provider.providerId,
							accountId: userInfo.id,
							accessToken: tokens.accessToken,
							refreshToken: tokens.refreshToken,
							accessTokenExpiresAt: tokens.accessTokenExpiresAt,
							refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
							scope: tokens.scopes?.join(","),
						});
						if (!newAccount) {
							return redirectOnError("unable_to_link_account");
						}
						let toRedirectTo: string;
						try {
							const url = callbackURL;
							toRedirectTo = url.toString();
						} catch {
							toRedirectTo = callbackURL;
						}
						throw ctx.redirect(toRedirectTo);
					}

					const result = await handleOAuthUserInfo(ctx, {
						userInfo: {
							...userInfo,
							...mapUser,
						},
						account: {
							providerId: provider.providerId,
							accountId: userInfo.id,
							...tokens,
							scope: tokens.scopes?.join(","),
						},
						disableSignUp:
							(provider.disableImplicitSignUp && !requestSignUp) ||
							provider.disableSignUp,
					});

					if (result.error) {
						return redirectOnError(result.error.split(" ").join("_"));
					}
					const { session, user } = result.data!;
					await setSessionCookie(ctx, {
						session,
						user,
					});
					let toRedirectTo: string;
					try {
						const url = result.isRegister
							? newUserURL || callbackURL
							: callbackURL;
						toRedirectTo = url.toString();
					} catch {
						toRedirectTo = result.isRegister
							? newUserURL || callbackURL
							: callbackURL;
					}
					throw ctx.redirect(toRedirectTo);
				},
			),
			oAuth2LinkAccount: createAuthEndpoint(
				"/oauth2/link",
				{
					method: "POST",
					body: z.object({
						providerId: z.string(),
						callbackURL: z.string(),
					}),
					use: [sessionMiddleware],
				},
				async (c) => {
					const session = c.context.session;
					const account = await c.context.internalAdapter.findAccounts(
						session.user.id,
					);
					const existingAccount = account.find(
						(a) => a.providerId === c.body.providerId,
					);
					if (existingAccount) {
						throw new APIError("BAD_REQUEST", {
							message: BASE_ERROR_CODES.SOCIAL_ACCOUNT_ALREADY_LINKED,
						});
					}
					const provider = options.config.find(
						(p) => p.providerId === c.body.providerId,
					);
					if (!provider) {
						throw new APIError("NOT_FOUND", {
							message: BASE_ERROR_CODES.PROVIDER_NOT_FOUND,
						});
					}
					const {
						providerId,
						clientId,
						clientSecret,
						redirectURI,
						authorizationUrl,
						discoveryUrl,
						pkce,
						scopes,
					} = provider;

					let finalAuthUrl = authorizationUrl;
					if (!finalAuthUrl) {
						if (!discoveryUrl) {
							throw new APIError("BAD_REQUEST", {
								message: ERROR_CODES.INVALID_OAUTH_CONFIGURATION,
							});
						}
						const discovery = await betterFetch<{
							authorization_endpoint: string;
							token_endpoint: string;
						}>(discoveryUrl, {
							onError(context) {
								c.context.logger.error(context.error.message, context.error, {
									discoveryUrl,
								});
							},
						});
						if (discovery.data) {
							finalAuthUrl = discovery.data.authorization_endpoint;
						}
					}

					if (!finalAuthUrl) {
						throw new APIError("BAD_REQUEST", {
							message: ERROR_CODES.INVALID_OAUTH_CONFIGURATION,
						});
					}

					const state = await generateState(c, {
						userId: session.user.id,
						email: session.user.email,
					});

					const url = await createAuthorizationURL({
						id: providerId,
						options: {
							clientId,
							clientSecret,
							redirectURI:
								redirectURI || `${c.context.baseURL}/oauth2/callback`,
						},
						authorizationEndpoint: finalAuthUrl,
						state: state.state,
						codeVerifier: pkce ? state.codeVerifier : undefined,
						scopes: scopes || [],
						redirectURI: `${c.context.baseURL}/oauth2/callback/${providerId}`,
					});

					return c.json({
						url: url.toString(),
						redirect: true,
					});
				},
			),
		},
		$ERROR_CODES: ERROR_CODES,
	} satisfies BetterAuthPlugin;
};
