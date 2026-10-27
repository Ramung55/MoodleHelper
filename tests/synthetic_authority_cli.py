"""Process boundary for isolated synthetic authority tests only."""
import json
import sys
from backend.synthetic_scan_authority import SyntheticAuthority

command, path, *args = sys.argv[1:]
if command == 'provision':
    authority = SyntheticAuthority.provision(path)
    print(json.dumps(authority.marker))
else:
    authority = SyntheticAuthority(path, args[0])
    if command == 'acquire':
        print(json.dumps(authority.acquire(int(args[1]))))
    elif command == 'release':
        print(json.dumps(authority.release_after_termination(args[1], int(args[2]))))
    else:
        raise ValueError('Unknown synthetic test operation')
