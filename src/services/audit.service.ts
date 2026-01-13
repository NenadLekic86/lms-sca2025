export class AuditService {
  static async logAction(_action: string, _userId: string, _metadata?: unknown) {
    return null;
  }

  static async getAuditLogs() {
    return [];
  }
}

