import type {Account, AccountData, AccessToken, RefreshToken, UnixTimestamp} from "./types";
import {loadAccounts, saveAccounts} from "./storage";

export class AccountManager {
    private readonly data: AccountData;

    constructor(data: AccountData) {
        this.data = data;
    }

    getAccounts(): Account[] {
        return this.data.accounts;
    }

    getCurrentOrNextAvailable(): Account | null {
        const accounts = this.getAccounts();
        if (accounts.length === 0) return null;

        const now = Date.now();
        const startIndex = this.data.activeIndex || 0;

        for (let i = 0; i < accounts.length; i++) {
            const idx = (startIndex + i) % accounts.length;
            const account = accounts[idx];
            if (!account.rateLimitResetTime || account.rateLimitResetTime < now) {
                return account;
            }
        }

        let earliest = accounts[0];
        for (const account of accounts) {
            if (
                !earliest.rateLimitResetTime ||
                (account.rateLimitResetTime && account.rateLimitResetTime < earliest.rateLimitResetTime)
            ) {
                earliest = account;
            }
        }
        return earliest;
    }

    getActiveAccount(): Account | null {
        const accounts = this.getAccounts();
        const index = this.data.activeIndex || 0;
        return accounts[index] || null;
    }

    isTokenExpired(account: Account): boolean {
        if (!account.expiresAt) return true;
        const bufferMs = 5 * 60 * 1000;
        return !account.expiresAt || Date.now() >= account.expiresAt - bufferMs;
    }

    addAccount({
                   name,
                   refreshToken,
                   accessToken,
                   expiresAt,
                   email,
                   uuid,
                   fullName,
                   displayName,
                   hasClaudeMax,
                   hasClaudePro,
                   plan,
                   organizationUuid,
                   organizationName,
                   organizationType,
                   billingType,
                   rateLimitTier,
                   hasExtraUsageEnabled,
               }: Partial<Account> & { name: string; refreshToken: string }): this {
        if (uuid) {
            this.data.accounts = this.data.accounts.filter((a) => a.uuid !== uuid);
        } else if (email) {
            this.data.accounts = this.data.accounts.filter((a) => a.email !== email);
        }

        this.data.accounts.push({
            name,
            refreshToken,
            accessToken,
            expiresAt,
            email,
            addedAt: Date.now(),
            lastUsed: 0,
            rateLimitResetTime: 0,
            uuid,
            fullName,
            displayName,
            hasClaudeMax,
            hasClaudePro,
            plan,
            organizationUuid,
            organizationName,
            organizationType,
            billingType,
            rateLimitTier,
            hasExtraUsageEnabled,
        });
        return this;
    }

    setActiveAccount(nameOrIndex: string | number): this {
        if (typeof nameOrIndex === "number") {
            this.data.activeIndex = nameOrIndex;
        } else {
            const idx = this.data.accounts.findIndex((a) => a.name === nameOrIndex);
            if (idx >= 0) {
                this.data.activeIndex = idx;
            }
        }
        return this;
    }

    updateTokens(
        account: Account,
        accessToken: AccessToken,
        expiresAt: UnixTimestamp,
        refreshToken?: RefreshToken
    ): this {
        account.accessToken = accessToken;
        account.expiresAt = expiresAt;
        if (refreshToken) {
            account.refreshToken = refreshToken;
        }
        return this;
    }

    markRateLimited(account: Account, retryAfterMs: number): this {
        account.rateLimitResetTime = Date.now() + retryAfterMs;
        return this;
    }

    static async loadFromDisk(): Promise<AccountManager> {
        const data = await loadAccounts();
        return new AccountManager(data);
    }

    async saveToDisk(): Promise<this> {
        await saveAccounts(this.data);
        return this;
    }
}
