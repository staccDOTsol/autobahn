import tempfile
import unittest
from pathlib import Path

from prepare_sbf import isolated_manifest, prepare


class SbfPreparationTests(unittest.TestCase):
    def test_manifest_preserves_program_dependencies_and_checks_overflow(self):
        before = '[package]\nname = "test"\n[dependencies]\nsolana-program = "1.17"\nspl-token = "4.0.0"\n[dev-dependencies]\nhelper = "1"\n'
        result = isolated_manifest(before)
        self.assertIn('solana-program = "=1.17.34"', result)
        self.assertIn('spl-token = "4.0.0"', result)
        self.assertNotIn('helper', result)
        self.assertIn('[profile.release]\noverflow-checks = true', result)
        self.assertIn('[workspace]', result)

    def test_unknown_manifest_requires_updated_explicit_build_recipe(self):
        for manifest in ['solana-program = "2"', 'solana-program = "1.17"\n[workspace]', 'solana-program = "1.17"\n[profile.release]']:
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                isolated_manifest(manifest)

    def test_actual_trusted_source_is_copied_without_keys_or_native_artifacts(self):
        policy = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'programs'
            prepare(policy, output)
            for name in ('autobahn-executor', 'mock_swap'):
                self.assertEqual((output / name / 'src/lib.rs').read_bytes(), (policy / 'programs' / name / 'src/lib.rs').read_bytes())
                self.assertEqual((output / name / 'Cargo.lock').read_bytes(), (policy / 'ci/sbf-locks' / f'{name}.lock').read_bytes())
                self.assertEqual({path.name for path in (output / name).iterdir()}, {'src', 'Cargo.toml', 'Cargo.lock'})
