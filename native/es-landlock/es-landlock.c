// SPDX-License-Identifier: MIT
/*
 * es-landlock: confine the calling process with Linux Landlock, then exec a
 * program in place (or run a functional probe of the applied ruleset).
 *
 *   es-landlock [--ro PATH]... [--rox PATH]... [--rw PATH]... \
 *               -- /abs/prog [prog-args...]
 *
 *   es-landlock --probe --probe-deny PATH --probe-rw DIR [--probe-rw DIR]... \
 *               [--ro PATH]... [--rox PATH]... [--rw PATH]...
 *
 * Failure is exactly one `es-landlock: <context>: <detail>` line on stderr and
 * exit 125; the program never runs. Success is silent and execve's the program
 * in place with the environment unchanged (no fork, no setsid, fds 0-2 intact).
 *
 * The Landlock UAPI is used through raw syscalls. The ruleset attribute struct
 * is local and zero-initialized: the kernel only rejects nonzero bytes past its
 * own known size, so the 24-byte struct is accepted by the ABI 3-5 kernels as
 * well as ABI 6+ (which knows the scoped field).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* UAPI fallbacks for headers older than the running kernel's ABI. */
#ifndef LANDLOCK_ACCESS_FS_EXECUTE
#define LANDLOCK_ACCESS_FS_EXECUTE (1ULL << 0)
#endif
#ifndef LANDLOCK_ACCESS_FS_WRITE_FILE
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#endif
#ifndef LANDLOCK_ACCESS_FS_READ_FILE
#define LANDLOCK_ACCESS_FS_READ_FILE (1ULL << 2)
#endif
#ifndef LANDLOCK_ACCESS_FS_READ_DIR
#define LANDLOCK_ACCESS_FS_READ_DIR (1ULL << 3)
#endif
#ifndef LANDLOCK_ACCESS_FS_REMOVE_DIR
#define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#endif
#ifndef LANDLOCK_ACCESS_FS_REMOVE_FILE
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_CHAR
#define LANDLOCK_ACCESS_FS_MAKE_CHAR (1ULL << 6)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_DIR
#define LANDLOCK_ACCESS_FS_MAKE_DIR (1ULL << 7)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_REG
#define LANDLOCK_ACCESS_FS_MAKE_REG (1ULL << 8)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_SOCK
#define LANDLOCK_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_FIFO
#define LANDLOCK_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_BLOCK
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_SYM
#define LANDLOCK_ACCESS_FS_MAKE_SYM (1ULL << 12)
#endif
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#endif
#ifndef LANDLOCK_SCOPE_SIGNAL
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif
#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif
#ifndef LANDLOCK_RULE_PATH_BENEATH
#define LANDLOCK_RULE_PATH_BENEATH 1
#endif

/* The launcher's own FS right set: bits 0-14, IOCTL_DEV (bit 15) excluded. */
#define ES_FS_RIGHTS ((1ULL << 15) - 1)

struct ll_ruleset_attr {
	__u64 handled_access_fs;
	__u64 handled_access_net;
	__u64 scoped;
};

enum grant_kind { GRANT_RO, GRANT_ROX, GRANT_RW };

struct grant {
	const char *path;
	enum grant_kind kind;
};

struct opened_grant {
	int fd;
	int is_dir;
	enum grant_kind kind;
};

extern char **environ;

static _Noreturn void die_msg(const char *ctx, const char *msg)
{
	dprintf(STDERR_FILENO, "es-landlock: %s: %s\n", ctx, msg);
	_exit(125);
}

static _Noreturn void die_errno(const char *ctx)
{
	int err = errno;

	dprintf(STDERR_FILENO, "es-landlock: %s: %s\n", ctx, strerror(err));
	_exit(125);
}

static void *xrealloc(void *ptr, size_t size)
{
	void *next = realloc(ptr, size);

	if (next == NULL)
		die_msg("setup", "out of memory");
	return next;
}

static void push_grant(struct grant **grants, size_t *count, const char *path,
		       enum grant_kind kind)
{
	struct grant *next = xrealloc(*grants, (*count + 1) * sizeof(**grants));

	next[*count].path = path;
	next[*count].kind = kind;
	*count += 1;
	*grants = next;
}

static void push_path(const char ***paths, size_t *count, const char *path)
{
	const char **next = xrealloc(*paths, (*count + 1) * sizeof(**paths));

	next[*count] = path;
	*count += 1;
	*paths = next;
}

static long ll_create_ruleset(const struct ll_ruleset_attr *attr, size_t size,
			      __u32 flags)
{
	return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static long ll_add_rule(int ruleset_fd, enum landlock_rule_type type,
			const struct landlock_path_beneath_attr *rule)
{
	return syscall(__NR_landlock_add_rule, ruleset_fd, type, rule, 0);
}

static long ll_restrict_self(int ruleset_fd, __u32 flags)
{
	return syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

/* Directory-only rights are the documented masks; a file target rejects them. */
static __u64 dir_rights(enum grant_kind kind, __u64 supported)
{
	__u64 rights = 0;

	switch (kind) {
	case GRANT_RO:
		rights = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
		break;
	case GRANT_ROX:
		rights = LANDLOCK_ACCESS_FS_READ_FILE |
			 LANDLOCK_ACCESS_FS_READ_DIR |
			 LANDLOCK_ACCESS_FS_EXECUTE;
		break;
	case GRANT_RW:
		rights = ES_FS_RIGHTS;
		break;
	}
	return rights & supported;
}

/* A file cannot carry READ_DIR or the MAKE/REMOVE rights: EINVAL on a file fd. */
static __u64 file_rights(enum grant_kind kind, __u64 supported)
{
	__u64 rights = 0;

	switch (kind) {
	case GRANT_RO:
		rights = LANDLOCK_ACCESS_FS_READ_FILE;
		break;
	case GRANT_ROX:
		rights = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE;
		break;
	case GRANT_RW:
		rights = LANDLOCK_ACCESS_FS_READ_FILE |
			 LANDLOCK_ACCESS_FS_WRITE_FILE |
			 LANDLOCK_ACCESS_FS_TRUNCATE;
		break;
	}
	return rights & supported;
}

static void close_extra_fds(void)
{
#ifdef __NR_close_range
	if (syscall(__NR_close_range, 3U, ~0U, 0) == 0)
		return;
#endif
	{
		long max = sysconf(_SC_OPEN_MAX);
		long fd;

		if (max < 0 || max > 65536)
			max = 65536;
		for (fd = 3; fd < max; fd++)
			close((int)fd);
	}
}

static void precheck_parent_environ(pid_t parent)
{
	char path[64];
	int fd;
	int n;

	n = snprintf(path, sizeof(path), "/proc/%d/environ", (int)parent);
	if (n < 0 || (size_t)n >= sizeof(path))
		die_msg("probe", "parent path too long");
	fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		die_errno("probe-parent-environ");
	close(fd);
}

static void probe_rw_dir(const char *dir)
{
	static const char payload[] = "es-landlock probe\n";
	char path[4096];
	char buf[sizeof(payload)];
	ssize_t n;
	int fd;
	int len;

	len = snprintf(path, sizeof(path), "%s/.es-landlock-probe-%d", dir,
		       (int)getpid());
	if (len < 0 || (size_t)len >= sizeof(path))
		die_msg("probe-write", "probe path too long");

	fd = open(path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
	if (fd < 0)
		die_errno("probe-write");
	n = write(fd, payload, sizeof(payload) - 1);
	if (n < 0)
		die_errno("probe-write");
	if ((size_t)n != sizeof(payload) - 1)
		die_msg("probe-write", "short write");
	if (close(fd) != 0)
		die_errno("probe-write");

	fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		die_errno("probe-read");
	n = read(fd, buf, sizeof(buf));
	if (n < 0)
		die_errno("probe-read");
	if ((size_t)n != sizeof(payload) - 1 ||
	    memcmp(buf, payload, sizeof(payload) - 1) != 0)
		die_msg("probe-read", "read-back mismatch");
	if (close(fd) != 0)
		die_errno("probe-read");

	if (unlink(path) != 0)
		die_errno("probe-remove");
}

static void probe_deny(const char *path)
{
	int fd = open(path, O_RDONLY | O_CLOEXEC);

	if (fd >= 0) {
		close(fd);
		die_msg("probe-deny",
			"deny path is readable under confinement");
	}
	if (errno != EACCES)
		die_errno("probe-deny");
}

static void probe_parent_ptrace(pid_t parent)
{
	char path[64];
	int fd;
	int n;

	n = snprintf(path, sizeof(path), "/proc/%d/stat", (int)parent);
	if (n < 0 || (size_t)n >= sizeof(path))
		die_msg("probe-parent-stat", "parent path too long");
	fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		die_errno("probe-parent-stat");
	close(fd);

	n = snprintf(path, sizeof(path), "/proc/%d/environ", (int)parent);
	if (n < 0 || (size_t)n >= sizeof(path))
		die_msg("probe-parent-environ", "parent path too long");
	fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd >= 0) {
		close(fd);
		die_msg("probe-parent-environ",
			"parent environ still readable under confinement");
	}
	if (errno != EACCES)
		die_errno("probe-parent-environ");
}

static void run_probe(const char *deny_path, const char **rw_dirs,
		      size_t rw_count, int abi, pid_t parent)
{
	size_t i;

	for (i = 0; i < rw_count; i++)
		probe_rw_dir(rw_dirs[i]);
	probe_deny(deny_path);
	probe_parent_ptrace(parent);

	if (dprintf(STDOUT_FILENO, "abi=%d\nenforcement=%s\n", abi,
		    abi >= 6 ? "full" : "partial") < 0)
		die_errno("probe-stdout");
}

int main(int argc, char **argv)
{
	struct grant *grants = NULL;
	size_t grant_count = 0;
	struct opened_grant *opened = NULL;
	const char **probe_rw = NULL;
	size_t probe_rw_count = 0;
	const char *probe_deny_path = NULL;
	int probe = 0;
	int prog_index = -1;
	pid_t parent = 0;
	long abi_raw;
	__u64 supported;
	long ruleset_fd;
	size_t i;
	int abi;
	int j;

	for (j = 1; j < argc; j++) {
		const char *arg = argv[j];

		if (strcmp(arg, "--") == 0) {
			if (j + 1 >= argc)
				die_msg("usage", "-- requires a program");
			prog_index = j + 1;
			break;
		} else if (strcmp(arg, "--probe") == 0) {
			probe = 1;
		} else if (strcmp(arg, "--probe-deny") == 0) {
			if (++j >= argc)
				die_msg("usage", "--probe-deny requires a path");
			probe_deny_path = argv[j];
		} else if (strcmp(arg, "--probe-rw") == 0) {
			if (++j >= argc)
				die_msg("usage", "--probe-rw requires a directory");
			push_path(&probe_rw, &probe_rw_count, argv[j]);
		} else if (strcmp(arg, "--ro") == 0) {
			if (++j >= argc)
				die_msg("usage", "--ro requires a path");
			push_grant(&grants, &grant_count, argv[j], GRANT_RO);
		} else if (strcmp(arg, "--rox") == 0) {
			if (++j >= argc)
				die_msg("usage", "--rox requires a path");
			push_grant(&grants, &grant_count, argv[j], GRANT_ROX);
		} else if (strcmp(arg, "--rw") == 0) {
			if (++j >= argc)
				die_msg("usage", "--rw requires a path");
			push_grant(&grants, &grant_count, argv[j], GRANT_RW);
		} else {
			die_msg("usage", "unknown argument");
		}
	}

	if (probe) {
		if (prog_index >= 0)
			die_msg("usage",
				"--probe cannot be combined with a program");
		if (probe_deny_path == NULL)
			die_msg("usage", "--probe requires --probe-deny");
		if (probe_rw_count == 0)
			die_msg("usage", "--probe requires at least one --probe-rw");
	} else {
		if (probe_deny_path != NULL || probe_rw_count != 0)
			die_msg("usage",
				"--probe-deny/--probe-rw require --probe");
		if (prog_index < 0)
			die_msg("usage", "missing -- before the program");
	}

	abi_raw = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
	if (abi_raw < 0)
		die_errno("landlock");
	if (abi_raw < 3) {
		char msg[96];

		snprintf(msg, sizeof(msg),
			 "Landlock ABI 3 or newer is required (got %ld)",
			 abi_raw);
		die_msg("abi", msg);
	}
	abi = (int)abi_raw;

	if (grant_count > 0)
		opened = xrealloc(NULL, grant_count * sizeof(*opened));
	for (i = 0; i < grant_count; i++) {
		struct stat st;
		int fd = open(grants[i].path, O_PATH | O_NOFOLLOW | O_CLOEXEC);

		if (fd < 0)
			die_errno("grant");
		if (fstat(fd, &st) != 0)
			die_errno("grant");
		if (S_ISLNK(st.st_mode))
			die_msg("grant", "refusing symlink");
		opened[i].fd = fd;
		opened[i].is_dir = S_ISDIR(st.st_mode);
		opened[i].kind = grants[i].kind;
	}

	if (probe) {
		/*
		 * Read the parent pid once: the pre-restriction open and the
		 * post-restriction pair must attribute to the same process, so a
		 * parent death in between cannot silently retarget the proof.
		 */
		parent = getppid();
		if (access(probe_deny_path, R_OK) != 0)
			die_errno("probe-deny");
		precheck_parent_environ(parent);
	}

	/*
	 * handled_access_fs is the launcher's own right set masked to the
	 * running ABI; IOCTL_DEV is deliberately never handled (arbitration 6).
	 * The UDP and RESOLVE_UNIX rights are newer than the set and stay
	 * unhandled, so the policy's meaning does not drift with the host.
	 */
	supported = ES_FS_RIGHTS & ~((__u64)LANDLOCK_ACCESS_FS_IOCTL_DEV);
	if (abi < 2)
		supported &= ~((__u64)LANDLOCK_ACCESS_FS_REFER);
	if (abi < 3)
		supported &= ~((__u64)LANDLOCK_ACCESS_FS_TRUNCATE);

	{
		struct ll_ruleset_attr attr;

		memset(&attr, 0, sizeof(attr));
		attr.handled_access_fs = supported;
		attr.handled_access_net = 0;
		attr.scoped = 0;
		if (abi >= 6)
			attr.scoped = LANDLOCK_SCOPE_SIGNAL |
				      LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET;
		ruleset_fd = ll_create_ruleset(&attr, sizeof(attr), 0);
		if (ruleset_fd < 0)
			die_errno("ruleset");
	}

	for (i = 0; i < grant_count; i++) {
		struct landlock_path_beneath_attr rule;
		__u64 allowed = opened[i].is_dir
			? dir_rights(opened[i].kind, supported)
			: file_rights(opened[i].kind, supported);

		memset(&rule, 0, sizeof(rule));
		rule.allowed_access = allowed;
		rule.parent_fd = opened[i].fd;
		if (ll_add_rule((int)ruleset_fd, LANDLOCK_RULE_PATH_BENEATH,
				&rule) < 0)
			die_errno("rule");
	}

	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
		die_errno("no-new-privs");
	if (ll_restrict_self((int)ruleset_fd, 0) < 0)
		die_errno("restrict");

	close_extra_fds();

	if (probe) {
		run_probe(probe_deny_path, probe_rw, probe_rw_count, abi, parent);
		return 0;
	}

	execve(argv[prog_index], &argv[prog_index], environ);
	die_errno("exec");
}
