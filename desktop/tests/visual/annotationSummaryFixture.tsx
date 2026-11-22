import { useState } from "react";
import { AnnotationSummary } from "../../src/plugins/project/conversation/ui/AnnotationSummary.tsx";
import type { DocumentAnnotation } from "../../src/plugins/documents/types.ts";

const sample: DocumentAnnotation = {
  id: "sample",
  project: "D:/demo",
  path: "D:/demo/发布检查.md",
  source: true,
  quote: "签名和归档完成后，再提交发布申请。",
  prefix: "",
  suffix: "",
  offset: 0,
  revision: "sample-revision",
  startLine: 4,
  endLine: 4,
  comment: "请补充回滚验证结果。",
};

export function AnnotationSummaryFixture() {
  const [annotation, setAnnotation] = useState(sample);
  return (
    <section aria-label="会话批注" className="bg-surface p-4">
      <AnnotationSummary
        annotations={[annotation]}
        className=""
        onChange={(next) => {
          setAnnotation(next);
          return true;
        }}
      />
    </section>
  );
}
