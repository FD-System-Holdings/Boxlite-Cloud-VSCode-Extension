export interface DiagnosticMessage {
  summary: string;
  checklist: string[];
}

export function diagnoseError(errorMessage: string, code?: string): DiagnosticMessage {
  const lower = errorMessage.toLowerCase();

  if (lower.includes('certificate_verify_failed') || lower.includes('ssl') && lower.includes('cafile') || lower.includes('ca-certificates')) {
    return {
      summary: 'TLS Certificate Verification Failed for Outbound Proxy',
      checklist: [
        'Configure your HTTP client inside the box to trust the system CA bundle (/etc/ssl/certs/ca-certificates.crt)',
        'In Python urllib, pass ssl.create_default_context(cafile="/etc/ssl/certs/ca-certificates.crt")',
        'Do not disable TLS certificate verification; ensure ca-certificates is installed in custom images (docs.boxlite.ai/cloud/secrets)'
      ]
    };
  }

  if (lower.includes('secret') && (lower.includes('header') || lower.includes('missing'))) {
    return {
      summary: 'Secret Configuration Missing Required Headers Mapping',
      checklist: [
        'Supply an explicit headers mapping on Secret, such as {"Authorization": "Bearer {value}"} or {"X-Api-Key": "{value}"}',
        'Verify the guest request already includes the target header with the <BOXLITE_SECRET:name> placeholder (the proxy replaces existing headers and does not add missing ones)'
      ]
    };
  }

  if (lower.includes('secret') || lower.includes('injection') || lower.includes('boxlite_secret')) {
    return {
      summary: 'Secret Proxy Injection Diagnosis',
      checklist: [
        'Verify both the destination hostname in Secret.hosts (without https:// or path) and an existing matching header in the guest request',
        'Use <BOXLITE_SECRET:name> in the guest request header or env var, and keep {value} in Secret.headers',
        'Ensure the box trusts /etc/ssl/certs/ca-certificates.crt for outbound HTTPS requests (docs.boxlite.ai/cloud/secrets)'
      ]
    };
  }

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

  if (lower.includes('401') || lower.includes('unauthorized') || (lower.includes('invalid credentials') && !lower.includes('403'))) {
    return {
      summary: '401 Unauthorized / Invalid Credentials',
      checklist: [
        'Verify that your BOXLITE_API_KEY is configured via "BoxLite: Sign In / Set API Key"',
        'Ensure your API key is valid and active on your Cloud environment',
        'Check installed SDK version and API environment (agent.md §5)'
      ]
    };
  }

  if (lower.includes('403') || lower.includes('html login') || lower.includes('forbidden')) {
    return {
      summary: '403 Forbidden / Access Denied',
      checklist: [
        'Check authentication/token and requested URL; do not assume either app health or one particular policy cause (agent.md §5)',
        'Verify that your BOXLITE_API_KEY has permissions for this Cloud environment or requested resource',
        'If this is a private tunnel, provide the X-BoxLite-Access-Token header with your secret token',
        'Do not infer managed database or shared-volume support if accessing volume resources (agent.md §4)',
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

  if (lower.includes('400') || lower.includes('bad request') || lower.includes('should not exist')) {
    return {
      summary: '400 Bad Request / Schema Validation Error',
      checklist: [
        'Check that request parameters match the BoxLite Cloud REST API schema',
        'Verify unsupported or deprecated fields (such as auto_remove) are not sent in request payload',
        'Ensure auto_stop is 0 (disabled) or at least 60 seconds'
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

  if (lower.includes('checkpoint')) {
    if (lower.includes('stopped') || lower.includes('idle')) {
      return {
        summary: 'Checkpoint Capture Requires Stopped Source Box',
        checklist: [
          'Stop the source box and wait until its status reaches "stopped" before creating a checkpoint',
          'Wait for any pending operations on the source box to complete',
          'Keep the source box stopped and intact until the checkpoint reaches "ready"'
        ]
      };
    }
    if (lower.includes('volume') || lower.includes('secret')) {
      return {
        summary: 'Source Box Attachments Not Supported for Checkpoints',
        checklist: [
          'A source box cannot have attached managed volumes or Secrets when creating a checkpoint',
          'Create a source box without volumes or Secrets, prepare its root disk, stop it, and capture the checkpoint'
        ]
      };
    }
    if (lower.includes('limit') || lower.includes('quota')) {
      return {
        summary: 'Checkpoint Quota / Limit Reached',
        checklist: [
          'List your checkpoints in the Checkpoints explorer and delete unneeded checkpoints',
          'Check your organization checkpoint quota before capturing another box'
        ]
      };
    }
    if (lower.includes('being created') || lower.includes('in use') || lower.includes('being used')) {
      return {
        summary: 'Checkpoint Operation In Progress',
        checklist: [
          'Wait for the active capture or restore operation to finish before deleting or reusing the checkpoint',
          'If a box restoration failed, remove the failed target box before retrying checkpoint deletion'
        ]
      };
    }
  }

  return {
    summary: 'Operation Failed',
    checklist: [
      `Inspect detailed error message: ${errorMessage}`,
      'Check BoxLite Cloud status and your account quota'
    ]
  };
}
