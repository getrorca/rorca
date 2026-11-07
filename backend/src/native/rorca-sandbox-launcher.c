/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Trusted Linux namespace launcher. Namespace and filesystem setup happens
 * before CLONE_NEWUSER while CAP_SYS_ADMIN is effective; the executed process
 * is then isolated in a child user namespace with an empty capability set.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <net/if.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/file.h>
#include <time.h>
#include <unistd.h>

#ifndef CLONE_NEWCGROUP
#define CLONE_NEWCGROUP 0x02000000
#endif

#define MAX_OPS 1024
#define MAX_ENVS 512

struct mount_op { const char *kind; const char *source; const char *destination; };
struct env_op { const char *name; const char *value; };

static void fail(const char *operation);
static void fail_message(const char *message);
static volatile sig_atomic_t g_signal_received = 0;
// pid_t is int on Linux; sig_atomic_t keeps the handler's read race-free.
static volatile sig_atomic_t g_child_pid = 0;

static void handle_termination(int signal_number) {
  g_signal_received = signal_number;
  if (g_child_pid > 0) kill(g_child_pid, SIGKILL);
}

static void install_termination_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = handle_termination;
  sigemptyset(&action.sa_mask);
  const int signals[] = { SIGTERM, SIGINT, SIGHUP };
  for (size_t index = 0; index < sizeof(signals) / sizeof(signals[0]); ++index) {
    if (sigaction(signals[index], &action, NULL) != 0) fail("install termination handler");
  }
}

static void sweep_stale_sandbox_roots(void) {
  // SIGKILLed launchers cannot run their cleanup path. The kernel frees the
  // private mount namespace (and its tmpfs mounts) when the last referencing
  // process dies, so only the mkdtemp directory survives. A live launcher's
  // tmpfs mount is visible ONLY inside its own private mount namespace, so
  // neither rmdir EBUSY nor the visibility of the underlying directory can
  // serve as a cross-namespace liveness check. Each launcher instead holds an
  // exclusive flock on its .owner marker file for its whole lifetime; the
  // kernel releases the lock when the process dies (including SIGKILL), so a
  // successful non-blocking LOCK_EX proves the root is dead. Any failure to
  // acquire the lock (or to open the marker) conservatively skips the entry.
  // The age gate additionally skips the short mkdtemp->flock window so a
  // concurrent launcher's fresh root is never touched before it takes the lock.
  DIR *directory = opendir("/tmp");
  if (!directory) return;
  const time_t now = time(NULL);
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strncmp(entry->d_name, "rorca-sandbox-root-", 19) != 0) continue;
    char path[4096], marker[4096];
    if (snprintf(path, sizeof(path), "/tmp/%s", entry->d_name) >= (int)sizeof(path)) continue;
    struct stat st;
    // lstat: a hostile symlink entry must never be followed to a target dir.
    if (lstat(path, &st) != 0 || !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode)) continue;
    if (now - st.st_mtime < 30) continue;
    if (snprintf(marker, sizeof(marker), "%s/.owner", path) >= (int)sizeof(marker)) continue;
    struct stat marker_st;
    // lstat: never follow a hostile symlink planted at the marker path.
    if (lstat(marker, &marker_st) != 0 || !S_ISREG(marker_st.st_mode)) continue;
    int marker_fd = open(marker, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (marker_fd < 0) continue;
    if (flock(marker_fd, LOCK_EX | LOCK_NB) != 0) {
      // Live (lock held by its launcher) or an error: never delete.
      close(marker_fd);
      continue;
    }
    if (unlink(marker) != 0 && errno != ENOENT) {
      close(marker_fd);
      continue;
    }
    close(marker_fd);
    if (rmdir(path) != 0 && errno != ENOENT) continue;
  }
  closedir(directory);
}

static void fail(const char *operation) {
  fprintf(stderr, "rorca-sandbox-launcher: %s: %s\n", operation, strerror(errno));
  exit(125);
}

static void fail_message(const char *message) {
  fprintf(stderr, "rorca-sandbox-launcher: %s\n", message);
  exit(125);
}

static bool within_root(const char *path) {
  return path && path[0] == '/' && strstr(path, "/../") == NULL
    && strcmp(path, "/..") != 0 && strstr(path, "//") == NULL;
}

static void rooted(char *output, size_t size, const char *root, const char *path) {
  if (!within_root(path) || snprintf(output, size, "%s%s", root, path) >= (int)size)
    fail_message("invalid or overlong sandbox destination");
}

static void mkdir_parents(const char *path, mode_t mode) {
  char copy[4096];
  if (strlen(path) >= sizeof(copy)) fail_message("sandbox path is too long");
  strcpy(copy, path);
  for (char *cursor = copy + 1; *cursor; ++cursor) {
    if (*cursor != '/') continue;
    *cursor = '\0';
    if (mkdir(copy, mode) != 0 && errno != EEXIST) fail("mkdir parent");
    *cursor = '/';
  }
}

static void ensure_directory(const char *path, mode_t mode) {
  mkdir_parents(path, mode);
  if (mkdir(path, mode) != 0 && errno != EEXIST) fail("mkdir");
  struct stat st;
  if (lstat(path, &st) != 0 || !S_ISDIR(st.st_mode)) fail_message("sandbox directory destination is not a directory");
}

static void ensure_mount_destination(const char *source, const char *destination) {
  struct stat st;
  if (lstat(source, &st) != 0) fail("stat bind source");
  if (S_ISDIR(st.st_mode)) {
    ensure_directory(destination, 0755);
    return;
  }
  mkdir_parents(destination, 0755);
  int fd = open(destination, O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) fail("create bind destination");
  close(fd);
}

static void bind_mount(const char *source, const char *destination, bool readonly) {
  ensure_mount_destination(source, destination);
  if (mount(source, destination, NULL, MS_BIND | MS_REC, NULL) != 0) fail("bind mount");
  if (readonly && mount(NULL, destination, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) != 0)
    fail("read-only bind remount");
}

static void write_exact(const char *path, const char *value) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) fail(path);
  size_t length = strlen(value);
  ssize_t written = write(fd, value, length);
  int saved = errno;
  close(fd);
  errno = saved;
  if (written != (ssize_t)length) fail(path);
}

static void map_container_root(void) {
  write_exact("/proc/self/uid_map", "0 0 1\n");
  write_exact("/proc/self/setgroups", "deny\n");
  write_exact("/proc/self/gid_map", "0 0 1\n");
}

static void drop_all_capabilities(void) {
  for (int capability = 0; capability <= 63; ++capability) {
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 && errno != EINVAL) fail("drop capability bounding set");
  }
  struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
  struct __user_cap_data_struct data[2] = { {0}, {0} };
  if (syscall(SYS_capset, &header, data) != 0) fail("clear capabilities");
}
static void enable_private_loopback(void) {
  int socket_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (socket_fd < 0) fail("open loopback control socket");
  struct ifreq request = {0};
  strcpy(request.ifr_name, "lo");
  if (ioctl(socket_fd, SIOCGIFFLAGS, &request) != 0) fail("read loopback flags");
  request.ifr_flags |= IFF_UP | IFF_RUNNING;
  if (ioctl(socket_fd, SIOCSIFFLAGS, &request) != 0) fail("enable private loopback");
  close(socket_fd);
}


static void append_component(char *output, size_t size, const char *parent, const char *name) {
  size_t parent_length = strlen(parent), name_length = strlen(name);
  if (parent_length + 1 + name_length + 1 > size) fail_message("sandbox path is too long");
  memcpy(output, parent, parent_length);
  output[parent_length] = '/';
  memcpy(output + parent_length + 1, name, name_length + 1);
}

static void setup_minimal_dev(const char *root) {
  char dev[4096], destination[4096], source[128];
  rooted(dev, sizeof(dev), root, "/dev");
  ensure_directory(dev, 0755);
  if (mount("tmpfs", dev, "tmpfs", MS_NOSUID | MS_NOEXEC, "mode=755,size=64k") != 0) fail("mount private dev");
  const char *devices[] = { "null", "zero", "full", "random", "urandom", "tty" };
  for (size_t index = 0; index < sizeof(devices) / sizeof(devices[0]); ++index) {
    snprintf(source, sizeof(source), "/dev/%s", devices[index]);
    append_component(destination, sizeof(destination), dev, devices[index]);
    bind_mount(source, destination, false);
  }
  char fd_link[4096];
  append_component(fd_link, sizeof(fd_link), dev, "fd");
  if (symlink("/proc/self/fd", fd_link) != 0) fail("create /dev/fd");
  const struct { const char *name; const char *target; } links[] = {
    { "stdin", "/proc/self/fd/0" }, { "stdout", "/proc/self/fd/1" }, { "stderr", "/proc/self/fd/2" }
  };
  for (size_t index = 0; index < sizeof(links) / sizeof(links[0]); ++index) {
    append_component(destination, sizeof(destination), dev, links[index].name);
    if (symlink(links[index].target, destination) != 0) fail("create dev fd link");
  }
}

int main(int argc, char **argv) {
  struct mount_op mounts[MAX_OPS]; size_t mount_count = 0;
  struct env_op envs[MAX_ENVS]; size_t env_count = 0;
  sweep_stale_sandbox_roots();
  install_termination_handlers();
  const char *sandbox_cwd = "/";
  int command_index = -1;

  for (int index = 1; index < argc;) {
    const char *argument = argv[index++];
    if (strcmp(argument, "--") == 0) { command_index = index; break; }
    if (!strcmp(argument, "--die-with-parent") || !strcmp(argument, "--new-session")
      || !strcmp(argument, "--unshare-all") || !strcmp(argument, "--clearenv")) continue;
    if (!strcmp(argument, "--cap-drop")) {
      if (index >= argc || strcmp(argv[index++], "ALL") != 0) fail_message("only --cap-drop ALL is supported");
      continue;
    }
    if (!strcmp(argument, "--hostname")) {
      if (index >= argc || strcmp(argv[index++], "rorca-autonomous") != 0) fail_message("unexpected sandbox hostname");
      continue;
    }
    if (!strcmp(argument, "--chdir")) {
      if (index >= argc) fail_message("missing --chdir value");
      sandbox_cwd = argv[index++]; continue;
    }
    if (!strcmp(argument, "--setenv")) {
      if (index + 1 >= argc || env_count == MAX_ENVS) fail_message("invalid --setenv");
      envs[env_count++] = (struct env_op){ argv[index], argv[index + 1] }; index += 2; continue;
    }
    if (!strcmp(argument, "--dir") || !strcmp(argument, "--tmpfs") || !strcmp(argument, "--proc") || !strcmp(argument, "--dev")) {
      if (index >= argc || mount_count == MAX_OPS) fail_message("invalid filesystem operation");
      mounts[mount_count++] = (struct mount_op){ argument, NULL, argv[index++] }; continue;
    }
    if (!strcmp(argument, "--bind") || !strcmp(argument, "--ro-bind")) {
      if (index + 1 >= argc || mount_count == MAX_OPS) fail_message("invalid bind operation");
      mounts[mount_count++] = (struct mount_op){ argument, argv[index], argv[index + 1] }; index += 2; continue;
    }
    if (!strcmp(argument, "--symlink")) {
      if (index + 1 >= argc || mount_count == MAX_OPS) fail_message("invalid symlink operation");
      mounts[mount_count++] = (struct mount_op){ argument, argv[index], argv[index + 1] }; index += 2; continue;
    }
    fail_message("unsupported launcher argument");
  }
  if (command_index < 0 || command_index >= argc || !within_root(sandbox_cwd)) fail_message("missing command or invalid cwd");

  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) fail("set parent-death signal");
  if (getppid() == 1) fail_message("launcher parent exited before isolation");
  int namespace_flags = CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP;
  if (unshare(namespace_flags) != 0) fail("unshare outer namespaces");
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) fail("make mounts private");

  char root[] = "/tmp/rorca-sandbox-root-XXXXXX";
  if (!mkdtemp(root)) fail("create sandbox root");
  char owner_marker[4096];
  if (snprintf(owner_marker, sizeof(owner_marker), "%s/.owner", root) >= (int)sizeof(owner_marker))
    fail_message("sandbox root owner marker path is too long");
  int owner_fd = open(owner_marker, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0600);
  if (owner_fd < 0) fail("create sandbox root owner marker");
  // The lock is released only by the kernel when this process dies, which is
  // exactly the cross-namespace liveness signal the stale-root sweep needs.
  if (flock(owner_fd, LOCK_EX) != 0) fail("lock sandbox root owner marker");
  if (mount("tmpfs", root, "tmpfs", MS_NOSUID | MS_NODEV, "mode=700") != 0) fail("mount sandbox root");

  pid_t child = fork();
  if (child < 0) fail("fork sandbox pid namespace");
  g_child_pid = child;
  // A signal that arrived between fork and this assignment is covered by the
  // handler racing the kill below; g_child_pid is set before any wait so a
  // later SIGTERM/SIGINT/SIGHUP always terminates the child.
  if (child > 0 && g_signal_received != 0) kill(child, SIGKILL);
  if (child == 0) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() == 1) fail("bind child lifecycle");
    if (setsid() < 0) fail("create sandbox session");
    if (sethostname("rorca-autonomous", strlen("rorca-autonomous")) != 0) fail("set sandbox hostname");

    char credential_mask[4096];
    append_component(credential_mask, sizeof(credential_mask), root, ".credential-mask");
    int credential_mask_fd = open(credential_mask, O_CREAT | O_EXCL | O_CLOEXEC, 0000);
    if (credential_mask_fd < 0) fail("create credential mask");
    close(credential_mask_fd);

    for (size_t index = 0; index < mount_count; ++index) {
      char destination[4096];
      rooted(destination, sizeof(destination), root, mounts[index].destination);
      if (!strcmp(mounts[index].kind, "--dir")) ensure_directory(destination, 0755);
      else if (!strcmp(mounts[index].kind, "--tmpfs")) {
        ensure_directory(destination, 0755);
        if (mount("tmpfs", destination, "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777") != 0) fail("mount sandbox tmpfs");
      } else if (!strcmp(mounts[index].kind, "--proc")) {
        ensure_directory(destination, 0555);
        // Read-only proc: the proc superblock is owned by the outer (container)
        // user namespace and the child's uid_map is an identity 0->0 mapping,
        // so the cap-dropped child would still pass the DAC owner check for
        // root-owned 0644 global sysctls (core_pattern and friends) on a
        // read-write mount. Docker's own protection masks /proc read-only;
        // a fresh read-write mount here would exceed the container's own
        // proc exposure. The child only reads proc, never writes it.
        if (mount("proc", destination, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_RDONLY, NULL) != 0) fail("mount sandbox proc");
      } else if (!strcmp(mounts[index].kind, "--dev")) setup_minimal_dev(root);
      else if (!strcmp(mounts[index].kind, "--bind")) bind_mount(mounts[index].source, destination, false);
      else if (!strcmp(mounts[index].kind, "--ro-bind"))
        bind_mount(!strcmp(mounts[index].source, "/dev/null") ? credential_mask : mounts[index].source, destination, true);
      else if (!strcmp(mounts[index].kind, "--symlink")) {
        mkdir_parents(destination, 0755);
        if (symlink(mounts[index].source, destination) != 0) fail("create sandbox symlink");
      }
    }
    if (unlink(credential_mask) != 0) fail("unlink credential mask source");

    if (unshare(CLONE_NEWUSER) != 0) fail("unshare user namespace");
    map_container_root();
    if (unshare(CLONE_NEWNS) != 0) fail("re-own mount namespace");
    if (unshare(CLONE_NEWNET) != 0) fail("unshare child network namespace");
    enable_private_loopback();
    if (mount(root, root, NULL, MS_BIND | MS_REC, NULL) != 0) fail("rebind sandbox root in child user namespace");
    char old_root[4096];
    snprintf(old_root, sizeof(old_root), "%s/.old-root", root);
    ensure_directory(old_root, 0700);
    if (chdir(root) != 0) fail("enter sandbox root mount");
    if (syscall(SYS_pivot_root, ".", ".old-root") != 0) fail("pivot sandbox root");
    if (chdir("/") != 0) fail("enter sandbox root");
    if (umount2("/.old-root", MNT_DETACH) != 0) fail("detach trusted root");
    if (rmdir("/.old-root") != 0) fail("remove old root mountpoint");
    if (chdir(sandbox_cwd) != 0) fail("enter sandbox cwd");

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("lock no-new-privileges");
    drop_all_capabilities();
    if (clearenv() != 0) fail("clear sandbox environment");
    for (size_t index = 0; index < env_count; ++index) {
      if (setenv(envs[index].name, envs[index].value, 1) != 0) fail("set sandbox environment");
    }
    execv(argv[command_index], &argv[command_index]);
    fail("exec sandbox command");
  }


  // Observe the child WITHOUT reaping (WNOWAIT): it remains a zombie, so its
  // pid cannot be recycled, and a handler running in this window can only
  // kill the already-dead zombie (harmless). Only after termination signals
  // are blocked do we reap and release the pid, so no handler can ever target
  // a recycled pid.
  siginfo_t child_info;
  while (waitid(P_PID, (id_t)child, &child_info, WEXITED | WNOWAIT) != 0) {
    if (errno == EINTR) continue;
    fail("observe sandbox child");
  }
  sigset_t termination_set;
  sigemptyset(&termination_set);
  sigaddset(&termination_set, SIGTERM);
  sigaddset(&termination_set, SIGINT);
  sigaddset(&termination_set, SIGHUP);
  if (sigprocmask(SIG_BLOCK, &termination_set, NULL) != 0) fail("block termination signals");
  if (waitpid(child, NULL, 0) < 0) fail("reap sandbox child");
  // The pid is now recyclable, but termination signals are blocked, so the
  // handler cannot run; the straggler becomes pending and is delivered later
  // with default dispositions.
  g_child_pid = 0;
  if (umount2(root, MNT_DETACH) != 0) fail("detach sandbox root after child");
  if (unlink(owner_marker) != 0 && errno != ENOENT) fail("remove sandbox root owner marker");
  // Hold the lifetime flock until AFTER rmdir so a peer sweep cannot race our
  // own teardown and remove the directory under us.
  if (rmdir(root) != 0) fail("remove sandbox root after child");
  close(owner_fd);
  // Restore default dispositions first, then unblock and re-raise: a raised
  // signal must be DELIVERED (default action) so consumers observe a real
  // signal termination, never a normal exit with a copied code. Pending
  // stragglers are likewise delivered by their default action after unblock.
  signal(SIGTERM, SIG_DFL);
  signal(SIGINT, SIG_DFL);
  signal(SIGHUP, SIG_DFL);
  if (g_signal_received != 0) {
    if (sigprocmask(SIG_UNBLOCK, &termination_set, NULL) != 0) fail("unblock termination signals");
    raise(g_signal_received);
    _exit(128 + g_signal_received);
  }
  if (sigprocmask(SIG_UNBLOCK, &termination_set, NULL) != 0) fail("unblock termination signals");
  if (child_info.si_code == CLD_EXITED) return child_info.si_status;
  if (child_info.si_code == CLD_KILLED || child_info.si_code == CLD_DUMPED) return 128 + child_info.si_status;
  return 125;
}
