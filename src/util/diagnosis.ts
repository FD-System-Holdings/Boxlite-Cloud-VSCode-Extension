export interface DiagnosticMessage {
  summary: string;
  checklist: string[];
}

export function diagnoseError(errorMessage: string, code?: string): DiagnosticMessage {
  const lower = errorMessage.toLowerCase();

  if (lower.includes('502') || lower.includes('unreachable')) {
    return {
      summary: '502 Bad Gateway / Box Unreachable',
      checklist: [
        'Check that your application binds to 0.0.0.0 (not 127.0.0.1 or localhost)',
        'Check guest logs (/tmp/server.log) to ensure the server process started without crashing',
        'Verify outbound network mode is enabled (NIC is active)',
        'Verify inbound network mode is enabled',
        'Ensure the tunnel port matches your server port'
      ]
    };
  }

  if (lower.includes('403') || lower.includes('html login') || lower.includes('forbidden')) {
    return {
      summary: '403 Forbidden / Access Denied',
      checklist: [
        'If this is a private tunnel, provide the X-BoxLite-Access-Token header with your secret token',
        'Verify that your BOXLITE_API_KEY is valid and has permissions for this Cloud environment',
        'Ensure the requested path is exposed by the running app'
      ]
    };
  }

  if (lower.includes('409') || lower.includes('already ran') || lower.includes('conflict')) {
    return {
      summary: '409 Conflict / Lifecycle Conflict',
      checklist: [
        'Inspect entrypoint: ensure PID 1 remains active in foreground (e.g. using a supervisor loop)',
        'Check if a box with the same name already exists in your account',
        'Inspect box status before retrying creation'
      ]
    };
  }

  if (code === 'NetworkError' || lower.includes('networkerror') || lower.includes('connection refused')) {
    return {
      summary: 'BoxLite Cloud Network Error',
      checklist: [
        'Check internet connectivity and DNS resolution',
        'Verify BOXLITE_REST_URL setting (default: https://api.boxlite.ai)',
        'Check if API environment is reachable and not experiencing downtime'
      ]
    };
  }

  return {
    summary: 'Operation Failed',
    checklist: [
      `Inspect detailed error message: ${errorMessage}`,
      'Check BoxLite Cloud status and your account quota'
    ]
  };
}
