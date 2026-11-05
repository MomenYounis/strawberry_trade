"""Fail-closed network recipe for an already ownership-checked synthetic AVD."""
import shlex

CHAIN = 'STRAWBERRY_SYNTHETIC'


def ensure_synthetic_firewall(device):
    """Repair interrupted setup; the caller keeps all radios off until return."""
    for binary in ['iptables', 'ip6tables']:
        existing = device('shell', binary, '-S').splitlines()
        if '-N ' + CHAIN not in existing:
            device('shell', binary, '-N', CHAIN)
        # This chain belongs exclusively to this test campaign. Rebuild it so
        # an interrupted or partially edited chain cannot retain an allow rule.
        device('shell', binary, '-F', CHAIN)
        device('shell', binary, '-A', CHAIN, '-o', 'lo', '-j', 'ACCEPT')
        if binary == 'iptables':
            device('shell', binary, '-A', CHAIN, '-d', '10.0.2.2', '-p', 'tcp',
                   '-m', 'multiport', '--dports', '8788,9099,18788', '-j', 'ACCEPT')
        device('shell', binary, '-A', CHAIN, '-j', 'REJECT')
        rules = [shlex.split(line) for line in device('shell', binary, '-S', CHAIN).splitlines()]
        expected = [['-N', CHAIN], ['-A', CHAIN, '-o', 'lo', '-j', 'ACCEPT']]
        if binary == 'iptables':
            expected.append(['-A', CHAIN, '-d', '10.0.2.2/32', '-p', 'tcp', '-m',
                             'multiport', '--dports', '8788,9099,18788', '-j', 'ACCEPT'])
        reject = ['-A', CHAIN, '-j', 'REJECT']
        if rules and rules[-1] == reject + ['--reject-with',
                'icmp-port-unreachable' if binary == 'iptables' else 'icmp6-port-unreachable']:
            rules[-1] = reject
        expected.append(reject)
        if rules != expected:
            raise RuntimeError('outbound-isolation-chain-mismatch')
        hook = ['-A', 'OUTPUT', '-j', CHAIN]
        output = [shlex.split(line) for line in device('shell', binary, '-S', 'OUTPUT').splitlines()
                  if line.startswith('-A ')]
        if not output or output[0] != hook:
            device('shell', binary, '-I', 'OUTPUT', '1', '-j', CHAIN)
        output = [shlex.split(line) for line in device('shell', binary, '-S', 'OUTPUT').splitlines()
                  if line.startswith('-A ')]
        if not output or output[0] != hook:
            raise RuntimeError('outbound-isolation-hook-missing')
