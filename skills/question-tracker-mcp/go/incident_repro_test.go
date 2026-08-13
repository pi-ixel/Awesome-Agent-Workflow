package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================
// 事故回归测试：2026-08 两起用户数据丢失事故
//
// 事故 1：sr-design 收尾时整个 SR 目录被删。
// 事故 2：模块详设收尾时一个 AR 目录被删。
//
// 根因：1.0 时代 CLI 残留的 .sdd/.current_session 标记指向
// .sdd/{SR}/（即 SR 全部工作区，内含用户设计文档）；空 session 的
// finalize_questions 走 legacy 兼容路由，finalizeLegacy 曾用
// os.RemoveAll(lr.dir) 把标记指向的整个目录递归删除。
//
// 设计约束（用户确认）：MCP 只管理问题池文件。迁移收尾只允许删除
// 池文件 .question_state.json 与标记 .current_session，永远不碰目录。
// ============================================================

// writeUserDocs 在 SR 工作区里放"用户心血文档"，返回路径列表。
func writeUserDocs(t *testing.T, srDir string) []string {
	t.Helper()
	docs := []string{
		filepath.Join(srDir, "SR-design.md"),
		filepath.Join(srDir, "workflow.yaml"),
		filepath.Join(srDir, "AR-001", "AR-clarify.md"),
	}
	for _, p := range docs {
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatalf("mkdir for user doc: %v", err)
		}
		if err := os.WriteFile(p, []byte("用户设计文档，严禁丢失"), 0644); err != nil {
			t.Fatalf("write user doc: %v", err)
		}
	}
	return docs
}

// TestIncident_LegacyFinalizeMustNotDeleteUserDocs 复刻事故 1：
// 标记指向 .sdd/SR-001/（1.0 标准布局），池已全部回答，
// 空 session finalize 后用户文档必须全部健在。
func TestIncident_LegacyFinalizeMustNotDeleteUserDocs(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-001/", "SR-001", legacyPoolJSON(
		legacyQuestion(1, "数据库选型？", "answered", "PostgreSQL"),
	))
	defer os.Chdir(origCwd)

	userDocs := writeUserDocs(t, filepath.Join(".sdd", "SR-001"))

	r := finalizeQuestionsTool("", "")
	if r["status"] != "ready" {
		t.Fatalf("expected ready, got: %v", r)
	}

	// 核心断言：用户文档必须全部健在（事故中它们被 RemoveAll 连锅端）
	for _, p := range userDocs {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("用户文档被误删（事故复现）: %s", p)
		}
	}
	// SR 目录本身必须保留
	if info, err := os.Stat(filepath.Join(".sdd", "SR-001")); err != nil || !info.IsDir() {
		t.Error("SR 目录必须保留——里面是用户自己的设计文档")
	}
	// MCP 只应清理自己的两个文件：池文件与标记
	if _, err := os.Stat(filepath.Join(".sdd", "SR-001", legacyStateName)); !os.IsNotExist(err) {
		t.Error("legacy 池文件应在迁移成功后被移除")
	}
	if _, err := os.Stat(legacyMarkerRel); !os.IsNotExist(err) {
		t.Error("legacy 标记文件应在迁移成功后被移除（拆除引线）")
	}
	// 迁移本身仍应发生：pool_location 指向新存储 .archive/ 且归档文件存在
	loc, _ := r["pool_location"].(string)
	if !strings.Contains(filepath.ToSlash(loc), archiveDirName) {
		t.Errorf("pool_location 应指向新存储 .archive/，got: %s", loc)
	}
	if _, err := os.Stat(loc); err != nil {
		t.Errorf("归档池文件应存在: %v", err)
	}
}

// TestIncident_ARDirectorySurvivesLegacyFinalize 复刻事故 2：
// 标记指向 .sdd/SR-001/AR-001/（AR 工作区），finalize 后
// AR 目录及其文档必须健在。
func TestIncident_ARDirectorySurvivesLegacyFinalize(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-001/AR-001/", "", "")
	defer os.Chdir(origCwd)

	// 手工布置 AR 级 legacy 池与文档
	arDir := filepath.Join(".sdd", "SR-001", "AR-001")
	if err := os.MkdirAll(arDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(arDir, legacyStateName), []byte(legacyPoolJSON(
		legacyQuestion(1, "缓存方案？", "answered", "Redis"),
	)), 0644); err != nil {
		t.Fatal(err)
	}
	userDocs := writeUserDocs(t, filepath.Join(".sdd", "SR-001"))
	arDoc := filepath.Join(arDir, "AR-001-模块详细设计说明书.md")
	if err := os.WriteFile(arDoc, []byte("详设文档"), 0644); err != nil {
		t.Fatal(err)
	}
	userDocs = append(userDocs, arDoc)

	r := finalizeQuestionsTool("", "")
	if r["status"] != "ready" {
		t.Fatalf("expected ready, got: %v", r)
	}

	for _, p := range userDocs {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("用户文档被误删（事故复现）: %s", p)
		}
	}
}

// ============================================================
// 标记路径安全边界：形态之外的标记一律视为无标记，
// 且不得读写/删除任何文件。
// ============================================================

func TestLegacyRouteRejectsUnsafeMarkerTargets(t *testing.T) {
	absTarget := t.TempDir() // 绝对路径标记
	cases := map[string]string{
		"sdd 本体":     ".sdd",
		"sdd 本体带 ./": "./.sdd/",
		"上级逃逸":       "../outside",
		"绝对路径":       absTarget,
		"sdd 内二次逃逸":  ".sdd/SR-001/../../evil",
	}
	for name, target := range cases {
		t.Run(name, func(t *testing.T) {
			origCwd := setupUpgradeScene(t, target, "", "")
			defer os.Chdir(origCwd)

			// 金丝雀文件：任何路径下都不许被动
			canary := filepath.Join(".sdd", "canary.md")
			if err := os.WriteFile(canary, []byte("不许动"), 0644); err != nil {
				t.Fatal(err)
			}

			r := getStatusTool("summary", "", "")
			if r["reason"] != "missing_session" || r["error"] != nil {
				t.Errorf("不安全标记 %q 应被拒绝并给出 missing_session 指引，got: %v", target, r)
			}
			r = finalizeQuestionsTool("", "")
			if r["reason"] != "missing_session" || r["error"] != nil {
				t.Errorf("不安全标记 %q finalize 应被拒绝并给出 missing_session 指引，got: %v", target, r)
			}
			if _, err := os.Stat(canary); err != nil {
				t.Errorf("金丝雀文件被动: %v", err)
			}
			if _, err := os.Stat(legacyMarkerRel); err != nil {
				t.Errorf("标记文件不应被改动: %v", err)
			}
		})
	}
}

// TestLegacyRouteAcceptsNormalSRTarget 正向兜底：标准 1.0 标记仍正常工作。
func TestLegacyRouteAcceptsNormalSRTarget(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-001/", "SR-001", legacyPoolJSON(
		legacyQuestion(1, "数据库选型？", "answered", "PostgreSQL"),
	))
	defer os.Chdir(origCwd)

	r := getStatusTool("summary", "", "")
	if r["error"] != nil {
		t.Fatalf("标准标记应正常走 legacy 路由，got: %v", r["error"])
	}
	if v, ok := getIntFromResult(r, "total"); !ok || v != 1 {
		t.Errorf("expected total=1, got %v", r["total"])
	}
}
