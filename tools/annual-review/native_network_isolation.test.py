import unittest
from native_network_isolation import CHAIN, ensure_synthetic_firewall


class Firewall:
    def __init__(self, hook=False, corrupt=False, drop_hook=False):
        self.rules = {b: [['-A', CHAIN, '-j', 'ACCEPT']] for b in ['iptables', 'ip6tables']}
        self.output = {b: [['-A', 'OUTPUT', '-j', CHAIN]] if hook else [] for b in self.rules}
        self.corrupt, self.drop_hook = corrupt, drop_hook
        self.calls = []

    def __call__(self, surface, binary, *args):
        self.calls.append((surface, binary, *args))
        assert surface == 'shell'
        if args == ('-S',):
            return '-N ' + CHAIN
        if args == ('-F', CHAIN):
            self.rules[binary] = []
        elif args[:2] == ('-A', CHAIN):
            rule = list(args)
            if '-d' in rule:
                rule[rule.index('-d') + 1] += '/32'
            self.rules[binary].append(rule)
        elif args == ('-S', CHAIN):
            rules = [['-N', CHAIN], *self.rules[binary]]
            if self.corrupt:
                rules.insert(1, ['-A', CHAIN, '-j', 'ACCEPT'])
            return '\n'.join(' '.join(rule) for rule in rules)
        elif args == ('-S', 'OUTPUT'):
            return '-P OUTPUT ACCEPT\n' + '\n'.join(' '.join(rule) for rule in self.output[binary])
        elif args == ('-I', 'OUTPUT', '1', '-j', CHAIN):
            if not self.drop_hook:
                self.output[binary].insert(0, ['-A', 'OUTPUT', '-j', CHAIN])
        else:
            raise AssertionError(args)
        return ''


class IsolationTest(unittest.TestCase):
    def test_existing_chain_without_hook_is_repaired_for_both_protocols(self):
        firewall = Firewall()
        ensure_synthetic_firewall(firewall)
        for binary in firewall.rules:
            self.assertEqual(firewall.output[binary][0], ['-A', 'OUTPUT', '-j', CHAIN])
            self.assertNotIn(['-A', CHAIN, '-j', 'ACCEPT'], firewall.rules[binary])

    def test_existing_late_hook_is_promoted_before_any_allow_rule(self):
        firewall = Firewall(hook=True)
        for binary in firewall.output:
            firewall.output[binary].insert(0, ['-A', 'OUTPUT', '-j', 'ACCEPT'])
        ensure_synthetic_firewall(firewall)
        self.assertTrue(all(v[0][-1] == CHAIN for v in firewall.output.values()))

    def test_unexpected_chain_rules_fail_before_any_hook_is_published(self):
        firewall = Firewall(corrupt=True)
        with self.assertRaisesRegex(RuntimeError, 'chain-mismatch'):
            ensure_synthetic_firewall(firewall)
        self.assertFalse(any('-I' in call for call in firewall.calls))

    def test_unconfirmed_hook_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'hook-missing'):
            ensure_synthetic_firewall(Firewall(drop_hook=True))

    def test_already_first_hook_is_verified_without_duplicate(self):
        firewall = Firewall(hook=True)
        ensure_synthetic_firewall(firewall)
        self.assertFalse(any('-I' in call for call in firewall.calls))


if __name__ == '__main__':
    unittest.main(verbosity=2)
