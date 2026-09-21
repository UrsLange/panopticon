import { z } from "zod";
import type { EntraConfig, PeopleSyncStatus } from "../../shared/people.js";
import { ApplicationError, ProfileCommitError } from "./errors.js";
import type {
  PeopleDirectory,
  PeopleSyncPorts,
  PeopleSyncSettings,
  PeopleSyncState,
} from "./people-ports.js";
export class PeopleSync {
  private task: Promise<PeopleSyncStatus> | null = null;
  private state: PeopleSyncState;
  constructor(
    private settings: PeopleSyncSettings,
    private directory: PeopleDirectory,
    private io: PeopleSyncPorts,
    private now = () => new Date(),
  ) {
    this.state = {
      ...this.empty(),
      ...io.loadStatus(),
    };
    this.migrate();
  }
  migrate() {
    try {
      const root = this.settings.profilePath;
      this.io.migrate(root, this.settings.entraCredentials()?.tenantId, (lastSuccess, count) => {
        this.state = {
          ...(this.state.profilePath === root ? this.state : this.empty()),
          lastSuccess,
          count,
          error: null,
        };
        this.persist();
      });
    } catch (error) {
      this.state = {
        ...this.empty(),
        error:
          error instanceof ProfileCommitError
            ? error.message
            : "People directory migration failed. Check people.md and local file permissions.",
      };
      this.persist();
    }
  }
  private empty() {
    return {
      profilePath: this.settings.profilePath,
      lastAttempt: null,
      lastSuccess: null,
      count: 0,
      skipped: 0,
      error: null,
      warnings: [],
    };
  }
  status(): PeopleSyncStatus {
    const { profilePath, ...state } =
      this.state.profilePath === this.settings.profilePath ? this.state : this.empty();
    return { ...state, running: !!this.task };
  }
  reset() {
    this.state = this.empty();
    this.persist();
  }
  private persist() {
    this.io.saveStatus(this.state);
  }

  request() {
    if (!this.settings.entraCredentials()?.enabled || !this.settings.profileReady)
      throw new ApplicationError(
        "invalid",
        "Connect a profile and enable Entra sync in Settings first.",
      );
    void this.run().catch(() => {});
    return this.status();
  }
  run(scheduled = false): Promise<PeopleSyncStatus> {
    if (this.task) return this.task;
    const config = this.settings.entraCredentials();
    if (!config?.enabled || !this.settings.profileReady) return Promise.resolve(this.status());
    const status = this.status();
    const now = this.now();
    if (
      scheduled &&
      ((!status.error &&
        status.lastSuccess &&
        this.directory.peopleSyncedAt(this.settings.profilePath, config.tenantId) &&
        now.getTime() - Date.parse(status.lastSuccess) < 86400000) ||
        (status.lastAttempt && now.getTime() - Date.parse(status.lastAttempt) < 900000))
    )
      return Promise.resolve(status);
    const root = this.settings.profilePath;
    this.task = this.sync(config, root, now).finally(() => {
      this.task = null;
    });
    return this.task;
  }
  private async sync(config: EntraConfig, root: string, now: Date): Promise<PeopleSyncStatus> {
    this.state = {
      ...this.status(),
      profilePath: root,
      lastAttempt: now.toISOString(),
      error: null,
    };
    try {
      const { people, skipped, warnings = [] } = await this.io.loadPeople(config);
      const syncedAt = this.now().toISOString();
      this.directory.replacePeople(root, config.tenantId, people, syncedAt);
      this.state = {
        ...this.state,
        lastSuccess: syncedAt,
        count: people.length,
        skipped,
        warnings,
        error: null,
      };
    } catch (error) {
      this.state.error =
        error instanceof Error &&
        !(error instanceof z.ZodError) &&
        /^(Azure CLI|Entra authentication|Graph |Directory request|Duplicate email)/.test(
          error.message,
        )
          ? error.message
          : "People sync failed. Check connectivity, directory data, and database write access. The previous directory is preserved.";
    }
    this.persist();
    return { ...this.status(), running: false };
  }
  async close() {
    await this.task;
  }
}
