#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
目录创建脚本
"""

from pathlib import Path


def create_directories():
    """
    创建.sdd目录及其子目录docs
    """
    # 获取当前目录
    current_dir = Path.cwd()

    # 定义要创建的目录
    sdd_dir = current_dir / ".sdd"

    # 创建.sdd目录
    try:
        if sdd_dir.exists():
            print(f"目录 {sdd_dir} 已存在")
        else:
            sdd_dir.mkdir(parents=True, exist_ok=True)
            print(f"成功创建目录: {sdd_dir}")
    except Exception as e:
        print(f"创建目录 {sdd_dir} 失败: {e}")
        return False
    return True


if __name__ == "__main__":
    create_directories()
