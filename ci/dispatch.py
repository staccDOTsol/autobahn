#!/usr/bin/env python3
import os
from admission_queue import dispatch_current
dispatch_current(os.environ['GITHUB_REPOSITORY'], os.environ['PR_NUMBER'])
