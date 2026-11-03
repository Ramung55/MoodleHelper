"""TEST ONLY: production application with a file-controlled lease clock."""
import os
from pathlib import Path
from backend.main import create_app
clock_file=Path(os.environ['QUEUE_TEST_CLOCK'])
app=create_app(queue_clock=lambda: int(clock_file.read_text()))
