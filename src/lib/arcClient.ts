export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  executionTime?: number;
}

export type StatementStatus = 'pending' | 'running' | 'success' | 'error';

export interface StatementResult {
  index: number;
  sql: string;
  status: StatementStatus;
  result?: QueryResult;
  error?: string;
  executionTime?: number;
}

export interface Measurement {
  database: string;
  table: string;
}

export interface TimeSeriesPoint {
  timestamp: string;
  values: Record<string, number>;
}

export interface TimeSeriesResponse {
  timestamp: string;
  type: string;
  duration_minutes: number;
  points_count: number;
  data: TimeSeriesPoint[];
}

export interface LogEntry {
  timestamp: string;
  level: string;
  component?: string;
  message: string;
  caller?: string;
}

export interface LogsResponse {
  timestamp: string;
  count: number;
  limit: number;
  level_filter: string;
  since_minutes: number;
  logs: LogEntry[];
}

export interface MetricsSnapshot {
  timestamp: string;
  uptime_seconds: number;
  goroutines: number;
  num_cpu: number;
  gomaxprocs: number;
  memory_alloc_bytes: number;
  memory_heap_alloc_bytes: number;
  memory_sys_bytes: number;
  gc_cycles: number;
  gc_pause_total_ns: number;
  http_requests_total: number;
  http_requests_success: number;
  http_requests_error: number;
  http_latency_sum_us: number;
  http_latency_count: number;
  query_requests_total: number;
  query_success_total: number;
  query_errors_total: number;
  query_rows_total: number;
  query_latency_sum_us: number;
  query_latency_count: number;
  ingest_records_total: number;
  ingest_bytes_total: number;
  db_connections_open: number;
  db_connections_in_use: number;
  [key: string]: string | number;
}

export interface EndpointMetrics {
  timestamp: string;
  http: {
    requests_total: number;
    requests_success: number;
    requests_error: number;
    latency_avg_ms: number;
  };
  ingestion: {
    records_total: number;
    bytes_total: number;
    batches_total: number;
    errors_total: number;
  };
  query: {
    requests_total: number;
    success_total: number;
    errors_total: number;
    rows_total: number;
    latency_avg_ms: number;
  };
  buffer: {
    records_buffered: number;
    records_written: number;
    flushes_total: number;
    queue_depth: number;
  };
  storage: {
    writes_total: number;
    write_bytes_total: number;
    reads_total: number;
    read_bytes_total: number;
    errors_total: number;
  };
  compaction: {
    jobs_total: number;
    jobs_success: number;
    jobs_failed: number;
    files_compacted: number;
  };
}

// Retention Policy types
export interface RetentionPolicy {
  id: number;
  name: string;
  database: string;
  measurement?: string | null;
  retention_days: number;
  buffer_days: number;
  is_active: boolean;
  last_execution_time?: string | null;
  last_execution_status?: string | null;
  last_deleted_count?: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRetentionPolicy {
  name: string;
  database: string;
  measurement?: string;
  retention_days: number;
  buffer_days?: number;
  is_active?: boolean;
}

export interface RetentionExecution {
  id: number;
  policy_id: number;
  execution_time: string;
  status: string;
  deleted_count: number;
  cutoff_date?: string | null;
  execution_duration_ms: number;
  error_message?: string | null;
}

export interface RetentionExecuteResult {
  policy_id: number;
  policy_name: string;
  deleted_count: number;
  files_deleted: number;
  execution_time_ms: number;
  dry_run: boolean;
  cutoff_date: string;
  affected_measurements: string[];
}

// Continuous Query types
export interface ContinuousQuery {
  id: number;
  name: string;
  description?: string | null;
  database: string;
  source_measurement: string;
  destination_measurement: string;
  query: string;
  interval: string;
  retention_days?: number | null;
  delete_source_after_days?: number | null;
  is_active: boolean;
  last_execution_time?: string | null;
  last_execution_status?: string | null;
  last_processed_time?: string | null;
  last_records_written?: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateContinuousQuery {
  name: string;
  description?: string;
  database: string;
  source_measurement: string;
  destination_measurement: string;
  query: string;
  interval: string;
  retention_days?: number;
  delete_source_after_days?: number;
  is_active?: boolean;
}

export interface CQExecution {
  id: number;
  query_id: number;
  execution_id: string;
  execution_time: string;
  status: string;
  start_time: string;
  end_time: string;
  records_read?: number | null;
  records_written: number;
  execution_duration_seconds: number;
  error_message?: string | null;
}

export interface CQExecuteOptions {
  dry_run?: boolean;
  start_time?: string;
  end_time?: string;
}

export interface CQExecuteResult {
  query_id: number;
  query_name: string;
  execution_id: string;
  records_read: number;
  records_written: number;
  execution_time_seconds: number;
  dry_run: boolean;
  start_time: string;
  end_time: string;
}

// Token Management types
export interface TokenInfo {
  id: number;
  name: string;
  description?: string;
  permissions: string[];
  created_at: string;
  last_used_at?: string;
  expires_at?: string;
  enabled: boolean;
}

export interface CreateTokenRequest {
  name: string;
  description?: string;
  permissions?: string[];
  expires_in?: string;
}

export interface CreateTokenResponse {
  token: string;
  message?: string;
}

export interface RotateTokenResponse {
  new_token: string;
}

export class ArcClient {
  constructor(private baseURL: string, private token: string) {}

  /**
   * Execute a SQL query
   * @param sql - The SQL query to execute
   * @param database - Optional database name to set via x-arc-database header (preferred over database.table syntax)
   */
  async query(sql: string, database?: string): Promise<QueryResult> {
    const startTime = performance.now();

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };

    // Use x-arc-database header when database is specified (more performant)
    if (database) {
      headers['x-arc-database'] = database;
    }

    const response = await fetch(`${this.baseURL}/api/v1/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Query failed: ${error}`);
    }

    const apiResponse = await response.json();
    const executionTime = performance.now() - startTime;

    return {
      columns: apiResponse.columns || [],
      rows: apiResponse.data || [],
      rowCount: apiResponse.row_count || 0,
      executionTime: apiResponse.execution_time_ms || executionTime
    };
  }

  async createDatabase(name: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/v1/databases`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
    }
  }

  async getMeasurements(): Promise<string[]> {
    const response = await fetch(`${this.baseURL}/api/v1/measurements`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch measurements');
    }

    const data = await response.json();
    return data.measurements || [];
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/health`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getMetrics(): Promise<MetricsSnapshot> {
    const response = await fetch(`${this.baseURL}/api/v1/metrics`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch metrics');
    }

    return response.json();
  }

  async getEndpointMetrics(): Promise<EndpointMetrics> {
    const response = await fetch(`${this.baseURL}/api/v1/metrics/endpoints`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch endpoint metrics');
    }

    return response.json();
  }

  async getTimeSeriesMetrics(type: 'system' | 'application' | 'api', durationMinutes: number = 30): Promise<TimeSeriesResponse> {
    const response = await fetch(`${this.baseURL}/api/v1/metrics/timeseries/${type}?duration_minutes=${durationMinutes}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${type} time series metrics`);
    }

    return response.json();
  }

  async getLogs(limit: number = 100, level?: string, sinceMinutes: number = 60): Promise<LogsResponse> {
    const params = new URLSearchParams({
      limit: limit.toString(),
      since_minutes: sinceMinutes.toString()
    });

    if (level) {
      params.set('level', level);
    }

    const response = await fetch(`${this.baseURL}/api/v1/logs?${params}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body?.error || '';
      } catch { /* ignore */ }
      if (response.status === 403 && /admin/i.test(detail)) {
        throw new Error('Viewing logs requires an admin token. Update this instance with an Arc token that has admin permission.');
      }
      throw new Error(detail || 'Failed to fetch logs');
    }

    return response.json();
  }

  // Retention Policy API methods
  async getRetentionPolicies(): Promise<RetentionPolicy[]> {
    const response = await fetch(`${this.baseURL}/api/v1/retention`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch retention policies: ${error}`);
    }

    return response.json();
  }

  async getRetentionPolicy(id: number): Promise<RetentionPolicy> {
    const response = await fetch(`${this.baseURL}/api/v1/retention/${id}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch retention policy: ${error}`);
    }

    return response.json();
  }

  async createRetentionPolicy(policy: CreateRetentionPolicy): Promise<RetentionPolicy> {
    const response = await fetch(`${this.baseURL}/api/v1/retention`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(policy)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create retention policy: ${error}`);
    }

    return response.json();
  }

  async updateRetentionPolicy(id: number, policy: Partial<CreateRetentionPolicy>): Promise<RetentionPolicy> {
    const response = await fetch(`${this.baseURL}/api/v1/retention/${id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(policy)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update retention policy: ${error}`);
    }

    return response.json();
  }

  async deleteRetentionPolicy(id: number): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/v1/retention/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete retention policy: ${error}`);
    }
  }

  async executeRetentionPolicy(id: number, dryRun: boolean = true): Promise<RetentionExecuteResult> {
    const response = await fetch(`${this.baseURL}/api/v1/retention/${id}/execute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ dry_run: dryRun, confirm: !dryRun })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to execute retention policy: ${error}`);
    }

    return response.json();
  }

  async getRetentionExecutions(id: number, limit: number = 10): Promise<RetentionExecution[]> {
    const response = await fetch(`${this.baseURL}/api/v1/retention/${id}/executions?limit=${limit}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch retention executions: ${error}`);
    }

    return response.json();
  }

  // Continuous Query API methods
  async getContinuousQueries(database?: string): Promise<ContinuousQuery[]> {
    const params = new URLSearchParams();
    if (database) {
      params.set('database', database);
    }

    const url = params.toString()
      ? `${this.baseURL}/api/v1/continuous_queries?${params}`
      : `${this.baseURL}/api/v1/continuous_queries`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch continuous queries: ${error}`);
    }

    return response.json();
  }

  async getContinuousQuery(id: number): Promise<ContinuousQuery> {
    const response = await fetch(`${this.baseURL}/api/v1/continuous_queries/${id}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch continuous query: ${error}`);
    }

    return response.json();
  }

  async createContinuousQuery(cq: CreateContinuousQuery): Promise<ContinuousQuery> {
    const response = await fetch(`${this.baseURL}/api/v1/continuous_queries`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(cq)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create continuous query: ${error}`);
    }

    return response.json();
  }

  async updateContinuousQuery(id: number, cq: Partial<CreateContinuousQuery>): Promise<ContinuousQuery> {
    const response = await fetch(`${this.baseURL}/api/v1/continuous_queries/${id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(cq)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update continuous query: ${error}`);
    }

    return response.json();
  }

  async deleteContinuousQuery(id: number): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/v1/continuous_queries/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete continuous query: ${error}`);
    }
  }

  async executeContinuousQuery(id: number, options: CQExecuteOptions = {}): Promise<CQExecuteResult> {
    const response = await fetch(`${this.baseURL}/api/v1/continuous_queries/${id}/execute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to execute continuous query: ${error}`);
    }

    return response.json();
  }

  async getCQExecutions(id: number, limit: number = 10): Promise<CQExecution[]> {
    const response = await fetch(`${this.baseURL}/api/v1/continuous_queries/${id}/executions?limit=${limit}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch continuous query executions: ${error}`);
    }

    return response.json();
  }

  // Token Management API methods
  async listTokens(): Promise<TokenInfo[]> {
    const response = await fetch(`${this.baseURL}/api/v1/auth/tokens`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list tokens: ${error}`);
    }

    const data = await response.json();
    return data.tokens || [];
  }

  async createToken(request: CreateTokenRequest): Promise<CreateTokenResponse> {
    const response = await fetch(`${this.baseURL}/api/v1/auth/tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create token: ${error}`);
    }

    return response.json();
  }

  async getToken(id: number): Promise<TokenInfo> {
    const response = await fetch(`${this.baseURL}/api/v1/auth/tokens/${id}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get token: ${error}`);
    }

    return response.json();
  }

  async updateToken(id: number, updates: Partial<CreateTokenRequest> & { enabled?: boolean }): Promise<TokenInfo> {
    const response = await fetch(`${this.baseURL}/api/v1/auth/tokens/${id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update token: ${error}`);
    }

    return response.json();
  }

  async deleteToken(id: number): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/v1/auth/tokens/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete token: ${error}`);
    }
  }

  async rotateToken(id: number): Promise<RotateTokenResponse> {
    const response = await fetch(`${this.baseURL}/api/v1/auth/tokens/${id}/rotate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to rotate token: ${error}`);
    }

    return response.json();
  }

  async revokeToken(id: number): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/v1/auth/tokens/${id}/revoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to revoke token: ${error}`);
    }
  }
}
