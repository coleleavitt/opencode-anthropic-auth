import {readFile, writeFile, access, chmod} from "fs/promises";
import {join} from "path";
import type {AccountData} from "./types";

const CONFIG_DIR = join(process.env.HOME!, ".config/opencode");
const ACCOUNTS_FILE = join(CONFIG_DIR, "anthropic-accounts.json");

export async function loadAccounts(): Promise<AccountData> {
    try {
        await access(ACCOUNTS_FILE);
        const content = await readFile(ACCOUNTS_FILE, "utf-8");
        return JSON.parse(content);
    } catch {
        return {
            version: 1,
            accounts: [],
        };
    }
}

export async function saveAccounts(data: AccountData): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    await writeFile(ACCOUNTS_FILE, content, {mode: 0o600});
    await chmod(ACCOUNTS_FILE, 0o600);
}
