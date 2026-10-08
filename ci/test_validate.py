import json
import os
from pathlib import Path
import tempfile
import unittest

from validate import copy_evidence, descriptor


class ValidationBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.descriptor = self.root / "lib/dex-test-venue/fixtures/admission.json"
        self.descriptor.parent.mkdir(parents=True)

    def write(self, amounts, options=None):
        self.descriptor.write_text(json.dumps({"amounts": amounts, "options": options if options is not None else {}}))

    def test_descriptor_requires_two_distinct_real_input_amounts(self):
        self.write([1, 2], {"pool": "public-key"})
        self.assertEqual(descriptor(self.root, "test-venue"), [1, 2])
        for amounts in [[1], [1, 1], [0, 2], [True, 2], [1, "2"], [1, 2**63], list(range(1, 10))]:
            with self.subTest(amounts=amounts):
                self.write(amounts)
                with self.assertRaises(ValueError):
                    descriptor(self.root, "test-venue")

    def test_descriptor_rejects_paths_symlinks_and_untyped_options(self):
        self.write([1, 2], {"pool": 123})
        with self.assertRaises(ValueError):
            descriptor(self.root, "test-venue")
        with self.assertRaises(ValueError):
            descriptor(self.root, "../test-venue")
        actual = self.root / "external.json"
        actual.write_text('{"amounts":[1,2],"options":{}}')
        self.descriptor.unlink()
        self.descriptor.symlink_to(actual)
        with self.assertRaises(ValueError):
            descriptor(self.root, "test-venue")

    def test_evidence_copy_accepts_only_bounded_nonempty_regular_file(self):
        original = self.root / "source.lz4"
        destination = self.root / "safe.lz4"
        original.write_bytes(b"actual bounded bytes")
        copy_evidence(original, destination)
        self.assertEqual(destination.read_bytes(), original.read_bytes())
        with self.assertRaises(FileExistsError):
            copy_evidence(original, destination)
        original.write_bytes(b"")
        with self.assertRaises(ValueError):
            copy_evidence(original, self.root / "empty.lz4")
        with original.open("wb") as stream:
            stream.truncate(256 * 1024 * 1024 + 1)
        with self.assertRaises(ValueError):
            copy_evidence(original, self.root / "large.lz4")

    def test_evidence_symlink_and_fifo_never_enter_trusted_verifier(self):
        original = self.root / "source.lz4"
        original.write_bytes(b"input")
        link = self.root / "link.lz4"
        link.symlink_to(original)
        with self.assertRaises(OSError):
            copy_evidence(link, self.root / "out.lz4")
        fifo = self.root / "pipe.lz4"
        os.mkfifo(fifo)
        with self.assertRaises(ValueError):
            copy_evidence(fifo, self.root / "out.lz4")


if __name__ == "__main__":
    unittest.main()
